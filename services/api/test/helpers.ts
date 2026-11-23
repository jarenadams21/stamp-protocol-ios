import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type pg from "pg";
import { buildApp } from "../src/app.ts";
import { devSigner, type DevSigner } from "../src/auth.ts";
import { createPool } from "../src/db.ts";
import { appleVerifier, googleVerifier, type IdTokenVerifier } from "../src/identity.ts";
import { LocalImageStore } from "../src/images.ts";
import { migrate } from "../src/migrate.ts";
import { MemoryCodeSender } from "../src/senders.ts";
import type { SignInOptions } from "../src/signIn.ts";

/**
 * A fresh schema with every migration applied, an app wired to it, and a token signer.
 * Uses the PG* settings from the environment (the Azure dev database locally, a Postgres service
 * container in CI). The schema is dropped by `close()`, so tests never touch real data.
 */
export interface TestContext {
    app: ReturnType<typeof buildApp>;
    pool: pg.Pool;
    signer: DevSigner;
    images: LocalImageStore;
    sms: MemoryCodeSender;
    email: MemoryCodeSender;
    apple: FakeProvider;
    google: FakeProvider;
    /** The sign-in settings the app was built with, for building variants. */
    signInOptions: SignInOptions;
    /** Moves the sign-in clock (phone codes, refresh expiry) forward by this many milliseconds. */
    clockOffsetMs: number;
    close(): Promise<void>;
}

/** Stands in for Apple or Google: signs ID tokens the API accepts as theirs. */
export interface FakeProvider {
    verifier: IdTokenVerifier;
    idToken(claims: {
        sub: string;
        nonce: string;
        aud?: string;
        iss?: string;
        iat?: number;
        exp?: string | number;
        email?: string;
        email_verified?: boolean | string;
    }): Promise<string>;
}

async function fakeProvider(make: typeof appleVerifier, issuer: string, audience: string): Promise<FakeProvider> {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: "fake", alg: "RS256" };
    const verifier = make([audience], createLocalJWKSet({ keys: [jwk] }));
    return {
        verifier,
        idToken: (claims) => {
            const extra: Record<string, unknown> = {};
            if (claims.email !== undefined) extra.email = claims.email;
            if (claims.email_verified !== undefined) extra.email_verified = claims.email_verified;
            const jwt = new SignJWT({ nonce: claims.nonce, ...extra })
                .setProtectedHeader({ alg: "RS256", kid: "fake" })
                .setIssuer(claims.iss ?? issuer)
                .setAudience(claims.aud ?? audience)
                .setSubject(claims.sub)
                .setExpirationTime(claims.exp ?? "1h");
            if (claims.iat === undefined) jwt.setIssuedAt();
            else jwt.setIssuedAt(claims.iat);
            return jwt.sign(privateKey);
        },
    };
}

export const TEST_PEPPER = "test-pepper-test-pepper-test-pepper";
export const APPLE_TEST_AUDIENCE = "com.joeyy.customer";
export const GOOGLE_TEST_AUDIENCE = "test-ios.apps.googleusercontent.com";

export async function setUp(): Promise<TestContext> {
    const schema = `test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = createPool(process.env, { max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = createPool(process.env, { searchPath: schema, max: 4 });
    await migrate(pool);
    const signer = await devSigner({ persist: false });
    // Images go to a temporary folder and are served by the app itself, like IMAGE_STORE=local.
    const imageDirectory = await mkdtemp(path.join(tmpdir(), "joeyy-images-"));
    const images = new LocalImageStore({ directory: imageDirectory, baseUrl: "http://localhost", urlTtlSeconds: 900 });
    const sms = new MemoryCodeSender();
    const email = new MemoryCodeSender();
    const apple = await fakeProvider(appleVerifier, "https://appleid.apple.com", APPLE_TEST_AUDIENCE);
    const google = await fakeProvider(googleVerifier, "https://accounts.google.com", GOOGLE_TEST_AUDIENCE);
    const ctx = {} as TestContext;
    const signInOptions: SignInOptions = {
        signer,
        methods: ["apple", "google", "phone", "email"],
        apple: apple.verifier,
        google: google.verifier,
        sms,
        email,
        hashPepper: TEST_PEPPER,
        phoneCountryCodes: ["1", "44"],
        now: () => new Date(Date.now() + ctx.clockOffsetMs),
    };
    const app = buildApp({ pool, auth: signer.config, images, signIn: signInOptions });
    await app.ready();
    return Object.assign(ctx, {
        app,
        pool,
        signer,
        images,
        sms,
        email,
        apple,
        google,
        signInOptions,
        clockOffsetMs: 0,
        async close() {
            await app.close();
            await rm(imageDirectory, { recursive: true, force: true });
            await pool.end();
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
            await admin.end();
        },
    });
}

export const validTheme = {
    lightPaper: "#F7EFD9",
    lightInk: "#2F241E",
    darkPaper: "#2F241E",
    darkInk: "#F7EFD9",
    typeface: "serif",
    artwork: "cloud",
    allowsMotion: true,
};

/** Calls the API as a signed-in partner. */
export async function asPartner(ctx: TestContext, subject: string, method: "GET" | "PUT" | "POST", url: string, body?: unknown) {
    const token = await ctx.signer.sign("partner", subject);
    const response = await ctx.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: response.statusCode, body: response.json() };
}

/** Calls the API as a signed-in customer. */
export async function asCustomer(ctx: TestContext, subject: string, url: string) {
    const token = await ctx.signer.sign("customer", subject);
    const response = await ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    return { status: response.statusCode, body: response.json() };
}

/** Uploads raw image bytes as a signed-in partner. */
export async function uploadImage(ctx: TestContext, subject: string, kind: string, data: Buffer, contentType = "image/png") {
    const token = await ctx.signer.sign("partner", subject);
    const response = await ctx.app.inject({
        method: "POST",
        url: `/v1/partner/images?kind=${kind}`,
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        payload: data,
    });
    return { status: response.statusCode, body: response.json() };
}

/** Downloads an image through a URL the API returned, with no token, as the apps do. */
export async function download(ctx: TestContext, url: string) {
    const { pathname, search } = new URL(url);
    return ctx.app.inject({ method: "GET", url: pathname + search });
}

/** Creates a business with a published v1 and returns its IDs. */
export async function businessWithProgram(ctx: TestContext, subject: string, requiredPunches = 10) {
    const business = await asPartner(ctx, subject, "PUT", "/v1/partner/business", { name: `Cafe ${subject}`, location: "Seattle" });
    const version = await asPartner(ctx, subject, "POST", "/v1/partner/program/versions", {
        requiredPunches,
        rewardDescription: "One drink",
        theme: validTheme,
    });
    return { businessId: business.body.id as string, versionId: version.body.versionId as string };
}

// Direct inserts for state that customer and punch handlers will create once they exist.

export async function insertCustomer(pool: pg.Pool, subject: string): Promise<string> {
    const result = await pool.query<{ id: string }>("INSERT INTO customers (subject) VALUES ($1) RETURNING id", [subject]);
    return result.rows[0]!.id;
}

export async function insertReader(pool: pg.Pool, businessId: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
        "INSERT INTO readers (business_id, credential_hash) VALUES ($1, $2) RETURNING id",
        [businessId, crypto.randomUUID()],
    );
    return result.rows[0]!.id;
}

export async function insertCard(
    pool: pg.Pool,
    card: { businessId: string; customerId: string; versionId: string; punches: number; status?: string; createdAt?: string; completedAt?: string },
): Promise<string> {
    const result = await pool.query<{ id: string }>(
        `INSERT INTO cards (business_id, customer_id, program_version_id, punches, status, created_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7) RETURNING id`,
        [card.businessId, card.customerId, card.versionId, card.punches, card.status ?? "active", card.createdAt ?? null, card.completedAt ?? null],
    );
    return result.rows[0]!.id;
}

export async function insertPunch(pool: pg.Pool, p: { businessId: string; cardId: string; readerId: string; occurredAt: string }) {
    await pool.query(
        "INSERT INTO punches (business_id, card_id, reader_id, event_id, occurred_at) VALUES ($1, $2, $3, $4, $5)",
        [p.businessId, p.cardId, p.readerId, crypto.randomUUID(), p.occurredAt],
    );
}

export async function insertReward(
    pool: pg.Pool,
    r: { businessId: string; cardId: string; customerId: string; earnedAt: string; redeemedAt?: string },
) {
    await pool.query(
        "INSERT INTO rewards (business_id, card_id, customer_id, earned_at, redeemed_at) VALUES ($1, $2, $3, $4, $5)",
        [r.businessId, r.cardId, r.customerId, r.earnedAt, r.redeemedAt ?? null],
    );
}
