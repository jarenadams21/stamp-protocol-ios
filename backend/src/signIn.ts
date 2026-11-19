import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Audience, TokenSigner } from "./auth.ts";
import { transaction } from "./db.ts";
import { ApiError, invalid, unauthorized } from "./errors.ts";
import { verifyIdToken, type IdTokenVerifier } from "./identity.ts";
import type { SmsSender } from "./sms.ts";

// Sign-in (docs/backend-spec.md section 8.5). Apple, Google, or a phone number and text code
// prove who someone is; the API then issues its own tokens for exactly one side. There is no
// email-and-password sign-in. The same person can have a customer account and a business owner
// account, but they are separate accounts, and each token works only on its own side.

export interface SignInOptions {
    signer: TokenSigner;
    apple: IdTokenVerifier;
    google: IdTokenVerifier;
    sms: SmsSender;
    /** Secret key for hashing phone numbers and codes, so neither is stored in the clear. */
    phonePepper: string;
    /** Country calling codes that may receive codes, without "+". Limits SMS fraud and cost. */
    phoneCountryCodes: string[];
    now?: () => Date;
}

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_DAYS = 60;
export const PHONE_CODE_SECONDS = 10 * 60;
export const PHONE_RESEND_SECONDS = 30;
export const PHONE_MAX_ATTEMPTS = 5;
export const PHONE_SENDS_PER_HOUR = 5;
/** Per client IP, per hour, across all sign-in routes. */
export const SIGN_INS_PER_IP_PER_HOUR = 60;
export const PHONE_STARTS_PER_IP_PER_HOUR = 10;

const tooManyRequests = (message = "Too many tries. Wait a bit and try again.") => new ApiError(429, "tooManyRequests", message);
const signInFailed = () => new ApiError(401, "signInFailed", "Sign-in didn't work. Try again.");
const signInUnavailable = () => new ApiError(503, "signInUnavailable", "This sign-in option isn't available yet.");
const smsUnavailable = () => new ApiError(503, "smsUnavailable", "We couldn't send a text right now. Try again soon.");
const invalidCode = () => invalid("invalidCode", "That code is wrong or has expired. Ask for a new one.");

/** A fixed-window counter per key, kept in memory. Enough for one API instance. */
export class RateLimiter {
    private readonly hits = new Map<string, { count: number; resetAt: number }>();
    private readonly limit: number;
    private readonly windowMs: number;

    constructor(limit: number, windowMs: number) {
        this.limit = limit;
        this.windowMs = windowMs;
    }

    /** Counts a hit; returns the seconds to wait when the limit is already reached. */
    hit(key: string, now = Date.now()): number | undefined {
        if (this.hits.size > 50_000) {
            for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
        }
        const entry = this.hits.get(key);
        if (!entry || entry.resetAt <= now) {
            this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
            return undefined;
        }
        if (entry.count >= this.limit) return Math.ceil((entry.resetAt - now) / 1000);
        entry.count += 1;
        return undefined;
    }
}

// Input -------------------------------------------------------------------------------------

function objectBody(request: FastifyRequest): Record<string, unknown> {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("invalidBody", "The request body couldn't be read.");
    return body as Record<string, unknown>;
}

function parseRole(value: unknown): Audience {
    if (value === "customer" || value === "partner") return value;
    throw invalid("invalidRole", 'role must be "customer" or "partner".');
}

function parseString(value: unknown, field: string, min: number, max: number): string {
    if (typeof value !== "string" || value.length < min || value.length > max) {
        throw invalid(`invalid${field[0]!.toUpperCase()}${field.slice(1)}`, `${field} is missing or invalid.`);
    }
    return value;
}

/** Returns the number in E.164 form (+15551234567), or throws `invalidPhoneNumber`. */
export function parsePhoneNumber(value: unknown, countryCodes: string[]): string {
    const fail = () => invalid("invalidPhoneNumber", "Enter a valid mobile number, including the country code.");
    if (typeof value !== "string" || value.length > 32) throw fail();
    const number = value.replace(/[\s().-]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(number)) throw fail();
    if (!countryCodes.some((code) => number.startsWith(`+${code}`))) {
        throw invalid("unsupportedPhoneNumber", "Phone sign-in isn't available for this country yet.");
    }
    if (number.startsWith("+1") && countryCodes.includes("1") && number.length !== 12) throw fail();
    return number;
}

// Hashing -----------------------------------------------------------------------------------

const hmac = (pepper: string, value: string) => createHmac("sha256", pepper).update(value).digest();
export const phoneHash = (pepper: string, number: string) => hmac(pepper, `phone:${number}`).toString("hex");
const codeHash = (pepper: string, phone: string, code: string) => hmac(pepper, `code:${phone}:${code}`);
const refreshHash = (token: string) => createHash("sha256").update(token).digest();

// Sessions ----------------------------------------------------------------------------------

interface Session {
    accessToken: string;
    tokenType: "Bearer";
    expiresIn: number;
    refreshToken: string;
}

async function issueSession(
    client: pg.PoolClient,
    options: SignInOptions,
    audience: Audience,
    subject: string,
    familyId: string = crypto.randomUUID(),
): Promise<Session> {
    const now = options.now?.() ?? new Date();
    const refreshToken = randomBytes(32).toString("base64url");
    await client.query(
        `INSERT INTO auth_refresh_tokens (family_id, token_hash, audience, subject, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [familyId, refreshHash(refreshToken), audience, subject, now, new Date(now.getTime() + REFRESH_TOKEN_DAYS * 86_400_000)],
    );
    return {
        accessToken: await options.signer.sign(audience, subject, ACCESS_TOKEN_SECONDS),
        tokenType: "Bearer",
        expiresIn: ACCESS_TOKEN_SECONDS,
        refreshToken,
    };
}

/** Signs in to one side: creates the customer or owner record on first sign-in, then a session. */
async function signIn(pool: pg.Pool, options: SignInOptions, audience: Audience, subject: string, client?: pg.PoolClient) {
    const run = async (c: pg.PoolClient) => {
        if (audience === "customer") {
            await c.query("INSERT INTO customers (subject) VALUES ($1) ON CONFLICT (subject) DO NOTHING", [subject]);
        } else {
            await c.query("INSERT INTO business_owners (subject) VALUES ($1) ON CONFLICT (subject) DO NOTHING", [subject]);
        }
        return issueSession(c, options, audience, subject);
    };
    return client ? run(client) : transaction(pool, run);
}

/** Deletes expired refresh tokens and stale phone rows. Run periodically. */
export async function pruneAuthRecords(pool: pg.Pool, now = new Date()) {
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const tokens = await pool.query("DELETE FROM auth_refresh_tokens WHERE expires_at < $1", [dayAgo]);
    const phones = await pool.query("DELETE FROM auth_phone_codes WHERE window_started_at < $1 AND expires_at < $2", [dayAgo, now]);
    return { refreshTokens: tokens.rowCount ?? 0, phoneCodes: phones.rowCount ?? 0 };
}

// Routes ------------------------------------------------------------------------------------

export async function signInRoutes(app: FastifyInstance, options: SignInOptions & { pool: pg.Pool }) {
    const { pool } = options;
    const clock = () => options.now?.() ?? new Date();
    const perIp = new RateLimiter(SIGN_INS_PER_IP_PER_HOUR, 3_600_000);
    const phoneStartsPerIp = new RateLimiter(PHONE_STARTS_PER_IP_PER_HOUR, 3_600_000);

    const limit = (limiter: RateLimiter, request: FastifyRequest, reply: FastifyReply) => {
        const wait = limiter.hit(request.ip, clock().getTime());
        if (wait !== undefined) {
            reply.header("retry-after", String(wait));
            throw tooManyRequests();
        }
    };

    app.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (request.method === "POST") limit(perIp, request, reply);
    });

    const providerRoute = (verifier: IdTokenVerifier, tokenField: "identityToken" | "idToken") => async (request: FastifyRequest) => {
        const body = objectBody(request);
        const role = parseRole(body.role);
        const token = parseString(body[tokenField], tokenField, 1, 8192);
        const nonce = parseString(body.nonce, "nonce", 16, 128);
        if (verifier.audiences.length === 0) throw signInUnavailable();
        const sub = await verifyIdToken(verifier, token, nonce);
        if (!sub) throw signInFailed();
        return signIn(pool, options, role, `${verifier.provider}:${sub}`);
    };

    app.post("/apple", providerRoute(options.apple, "identityToken"));
    app.post("/google", providerRoute(options.google, "idToken"));

    app.post("/phone/start", async (request, reply) => {
        const body = objectBody(request);
        const number = parsePhoneNumber(body.phoneNumber, options.phoneCountryCodes);
        limit(phoneStartsPerIp, request, reply);
        const phone = phoneHash(options.phonePepper, number);
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        const now = clock();
        const expiresAt = new Date(now.getTime() + PHONE_CODE_SECONDS * 1000);

        const wait = await transaction(pool, async (client) => {
            const existing = await client.query<{ sent_at: Date; window_started_at: Date; sends_in_window: number }>(
                "SELECT sent_at, window_started_at, sends_in_window FROM auth_phone_codes WHERE phone_hash = $1 FOR UPDATE",
                [phone],
            );
            const row = existing.rows[0];
            if (row) {
                const sinceSent = (now.getTime() - row.sent_at.getTime()) / 1000;
                if (sinceSent < PHONE_RESEND_SECONDS) return Math.ceil(PHONE_RESEND_SECONDS - sinceSent);
                const windowEnds = row.window_started_at.getTime() + 3_600_000;
                const sameWindow = windowEnds > now.getTime();
                if (sameWindow && row.sends_in_window >= PHONE_SENDS_PER_HOUR) return Math.ceil((windowEnds - now.getTime()) / 1000);
                await client.query(
                    `UPDATE auth_phone_codes
                     SET code_hash = $2, expires_at = $3, attempts = 0, sent_at = $4,
                         window_started_at = $5, sends_in_window = $6
                     WHERE phone_hash = $1`,
                    [phone, codeHash(options.phonePepper, phone, code), expiresAt, now,
                        sameWindow ? row.window_started_at : now, sameWindow ? row.sends_in_window + 1 : 1],
                );
            } else {
                const inserted = await client.query(
                    `INSERT INTO auth_phone_codes (phone_hash, code_hash, expires_at, sent_at, window_started_at, sends_in_window)
                     VALUES ($1, $2, $3, $4, $4, 1) ON CONFLICT (phone_hash) DO NOTHING`,
                    [phone, codeHash(options.phonePepper, phone, code), expiresAt, now],
                );
                // Another request for the same number got there first.
                if (inserted.rowCount === 0) return PHONE_RESEND_SECONDS;
            }
            // Sent inside the transaction, so a failed text doesn't use up the cooldown or limit.
            try {
                await options.sms.send(number, `${code} is your JOEYY code. It expires in 10 minutes. Don't share it.`);
            } catch (error) {
                request.log.error({ err: error, sms: options.sms.label }, "sign-in text not sent");
                throw smsUnavailable();
            }
            return undefined;
        });
        if (wait !== undefined) {
            reply.header("retry-after", String(wait));
            throw tooManyRequests("A code was sent recently. Wait a bit before asking for another.");
        }
        return reply.code(202).send({ expiresIn: PHONE_CODE_SECONDS, resendAfter: PHONE_RESEND_SECONDS });
    });

    app.post("/phone/verify", async (request) => {
        const body = objectBody(request);
        const role = parseRole(body.role);
        const number = parsePhoneNumber(body.phoneNumber, options.phoneCountryCodes);
        if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) throw invalidCode();
        const code = body.code;
        const phone = phoneHash(options.phonePepper, number);
        const now = clock();

        // A wrong guess must be counted even though the request fails, so the transaction returns
        // the outcome instead of throwing.
        const outcome = await transaction(pool, async (client) => {
            const result = await client.query<{ code_hash: Buffer | null; expires_at: Date; attempts: number }>(
                "SELECT code_hash, expires_at, attempts FROM auth_phone_codes WHERE phone_hash = $1 FOR UPDATE",
                [phone],
            );
            const row = result.rows[0];
            if (!row?.code_hash || row.expires_at <= now) return { ok: false as const };
            if (!timingSafeEqual(row.code_hash, codeHash(options.phonePepper, phone, code))) {
                const attempts = row.attempts + 1;
                await client.query(
                    "UPDATE auth_phone_codes SET attempts = $2::int, code_hash = CASE WHEN $2::int >= $3::int THEN NULL ELSE code_hash END WHERE phone_hash = $1",
                    [phone, attempts, PHONE_MAX_ATTEMPTS],
                );
                return { ok: false as const };
            }
            await client.query("UPDATE auth_phone_codes SET code_hash = NULL WHERE phone_hash = $1", [phone]);
            return { ok: true as const, session: await signIn(pool, options, role, `phone:${phone}`, client) };
        });
        if (!outcome.ok) throw invalidCode();
        return outcome.session;
    });

    app.post("/refresh", async (request) => {
        const body = objectBody(request);
        const token = body.refreshToken;
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
        const now = clock();
        const outcome = await transaction(pool, async (client) => {
            const result = await client.query<{
                id: string;
                family_id: string;
                audience: Audience;
                subject: string;
                expires_at: Date;
                used_at: Date | null;
                revoked_at: Date | null;
            }>(
                `SELECT id, family_id, audience, subject, expires_at, used_at, revoked_at
                 FROM auth_refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
                [refreshHash(token)],
            );
            const row = result.rows[0];
            if (!row) return undefined;
            if (row.used_at || row.revoked_at) {
                // A rotated or revoked token came back: sign out every device in this family.
                await client.query("UPDATE auth_refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id, now]);
                if (row.used_at && !row.revoked_at) request.log.warn({ family: row.family_id }, "refresh token reused; session revoked");
                return undefined;
            }
            if (row.expires_at <= now) return undefined;
            await client.query("UPDATE auth_refresh_tokens SET used_at = $2 WHERE id = $1", [row.id, now]);
            return issueSession(client, options, row.audience, row.subject, row.family_id);
        });
        if (!outcome) throw unauthorized();
        return outcome;
    });

    app.post("/sign-out", async (request, reply) => {
        const body = objectBody(request);
        const token = body.refreshToken;
        if (typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)) {
            await pool.query(
                `UPDATE auth_refresh_tokens SET revoked_at = $2
                 WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM auth_refresh_tokens WHERE token_hash = $1)`,
                [refreshHash(token), clock()],
            );
        }
        return reply.code(204).send();
    });
}
