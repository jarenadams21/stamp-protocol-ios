import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Audience, TokenSigner } from "./auth.ts";
import { transaction } from "./db.ts";
import { ApiError, invalid, unauthorized } from "./errors.ts";
import { verifyIdToken, type IdTokenVerifier } from "./identity.ts";
import type { CodeSender } from "./senders.ts";

// Sign-in (docs/backend-spec.md section 8.5). Apple, Google, or a one-time code sent by text or
// email proves who someone is; the API then issues its own tokens for exactly one side. There is
// no password anywhere. The same person can have a customer account and a business owner account,
// but they are separate accounts, and each token works only on its own side.

export const SIGN_IN_METHODS = ["apple", "google", "phone", "email"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export interface SignInOptions {
    signer: TokenSigner;
    /** Methods that are switched on. The others answer `503 signInUnavailable`. */
    methods: SignInMethod[];
    apple: IdTokenVerifier;
    google: IdTokenVerifier;
    sms: CodeSender;
    email: CodeSender;
    /** Secret key for hashing phone numbers, email addresses, and codes in subjects and code records. */
    hashPepper: string;
    /** Country calling codes that may receive texts, without "+". Limits SMS fraud and cost. */
    phoneCountryCodes: string[];
    now?: () => Date;
}

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_DAYS = 60;
export const CODE_SECONDS = 10 * 60;
export const CODE_RESEND_SECONDS = 30;
export const CODE_MAX_ATTEMPTS = 5;
/** Codes sent to one phone number or email address per hour. */
export const CODE_SENDS_PER_HOUR = 5;
/** Per client IP, per hour, across all sign-in routes. */
export const SIGN_INS_PER_IP_PER_HOUR = 60;
/** Per client IP, per hour, across text and email codes. */
export const CODE_STARTS_PER_IP_PER_HOUR = 10;

const tooManyRequests = (message = "Too many tries. Wait a bit and try again.") => new ApiError(429, "tooManyRequests", message);
const signInFailed = () => new ApiError(401, "signInFailed", "Sign-in didn't work. Try again.");
const signInUnavailable = () => new ApiError(503, "signInUnavailable", "This sign-in option isn't available yet.");
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

/** Returns the address trimmed and lowercased, or throws `invalidEmail`. */
export function parseEmail(value: unknown): string {
    const fail = () => invalid("invalidEmail", "Enter a valid email address.");
    if (typeof value !== "string") throw fail();
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+\.[^\s@<>()"',;:\\]{2,}$/.test(email)) throw fail();
    if (email.split("@")[0]!.length > 64) throw fail();
    return email;
}

// Hashing -----------------------------------------------------------------------------------

type CodeChannel = "phone" | "email";
const hmac = (pepper: string, value: string) => createHmac("sha256", pepper).update(value).digest();
/** Keyed hash of a normalized phone number or email address. Also the account subject's suffix. */
export const targetHash = (pepper: string, channel: CodeChannel, target: string) => hmac(pepper, `${channel}:${target}`).toString("hex");
/** Kept for readability in tests: the phone subject's hash. */
export const phoneHash = (pepper: string, number: string) => targetHash(pepper, "phone", number);
const codeHash = (pepper: string, target: string, code: string) => hmac(pepper, `code:${target}:${code}`);
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

/**
 * Signs in to one side: creates the customer or owner record on first sign-in, records the verified
 * email address (kept when this sign-in didn't carry one) and the time, then starts a session.
 */
async function signIn(pool: pg.Pool, options: SignInOptions, audience: Audience, subject: string, email: string | undefined, client?: pg.PoolClient) {
    const run = async (c: pg.PoolClient) => {
        const table = audience === "customer" ? "customers" : "business_owners";
        await c.query(
            `INSERT INTO ${table} AS account (subject, email, last_sign_in_at) VALUES ($1, $2, $3)
             ON CONFLICT (subject) DO UPDATE
             SET email = COALESCE(EXCLUDED.email, account.email), last_sign_in_at = EXCLUDED.last_sign_in_at`,
            [subject, email ?? null, options.now?.() ?? new Date()],
        );
        return issueSession(c, options, audience, subject);
    };
    return client ? run(client) : transaction(pool, run);
}

/** Deletes expired refresh tokens and stale code rows. Run periodically. */
export async function pruneAuthRecords(pool: pg.Pool, now = new Date()) {
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const tokens = await pool.query("DELETE FROM auth_refresh_tokens WHERE expires_at < $1", [dayAgo]);
    const codes = await pool.query("DELETE FROM auth_codes WHERE window_started_at < $1 AND expires_at < $2", [dayAgo, now]);
    return { refreshTokens: tokens.rowCount ?? 0, codes: codes.rowCount ?? 0 };
}

// Routes ------------------------------------------------------------------------------------

export async function signInRoutes(app: FastifyInstance, options: SignInOptions & { pool: pg.Pool }) {
    const { pool } = options;
    const clock = () => options.now?.() ?? new Date();
    const perIp = new RateLimiter(SIGN_INS_PER_IP_PER_HOUR, 3_600_000);
    const codeStartsPerIp = new RateLimiter(CODE_STARTS_PER_IP_PER_HOUR, 3_600_000);
    const enabled = (method: SignInMethod) => {
        if (!options.methods.includes(method)) throw signInUnavailable();
    };

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

    /** Which sign-in options the apps and website should show. */
    app.get("/methods", async () => ({
        methods: options.methods.filter((method) => method !== "google" || options.google.audiences.length > 0),
    }));

    const providerRoute = (verifier: IdTokenVerifier, tokenField: "identityToken" | "idToken") => async (request: FastifyRequest) => {
        enabled(verifier.provider);
        const body = objectBody(request);
        const role = parseRole(body.role);
        const token = parseString(body[tokenField], tokenField, 1, 8192);
        const nonce = parseString(body.nonce, "nonce", 16, 128);
        if (verifier.audiences.length === 0) throw signInUnavailable();
        const identity = await verifyIdToken(verifier, token, nonce);
        if (!identity) throw signInFailed();
        return signIn(pool, options, role, `${verifier.provider}:${identity.sub}`, identity.email);
    };

    app.post("/apple", providerRoute(options.apple, "identityToken"));
    app.post("/google", providerRoute(options.google, "idToken"));

    // One-time codes by text or email -------------------------------------------------------

    interface Channel {
        method: CodeChannel;
        field: "phoneNumber" | "email";
        parse(value: unknown): string;
        sender: CodeSender;
        unavailable(): ApiError;
    }
    const channels: Channel[] = [
        {
            method: "phone",
            field: "phoneNumber",
            parse: (value) => parsePhoneNumber(value, options.phoneCountryCodes),
            sender: options.sms,
            unavailable: () => new ApiError(503, "smsUnavailable", "We couldn't send a text right now. Try again soon."),
        },
        {
            method: "email",
            field: "email",
            parse: parseEmail,
            sender: options.email,
            unavailable: () => new ApiError(503, "emailUnavailable", "We couldn't send an email right now. Try again soon."),
        },
    ];

    for (const channel of channels) {
        app.post(`/${channel.method}/start`, async (request, reply) => {
            enabled(channel.method);
            const body = objectBody(request);
            const target = channel.parse(body[channel.field]);
            limit(codeStartsPerIp, request, reply);
            const key = targetHash(options.hashPepper, channel.method, target);
            const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
            const now = clock();
            const expiresAt = new Date(now.getTime() + CODE_SECONDS * 1000);
            const hashed = codeHash(options.hashPepper, key, code);

            const wait = await transaction(pool, async (client) => {
                const existing = await client.query<{ sent_at: Date; window_started_at: Date; sends_in_window: number }>(
                    "SELECT sent_at, window_started_at, sends_in_window FROM auth_codes WHERE target_hash = $1 FOR UPDATE",
                    [key],
                );
                const row = existing.rows[0];
                if (row) {
                    const sinceSent = (now.getTime() - row.sent_at.getTime()) / 1000;
                    if (sinceSent < CODE_RESEND_SECONDS) return Math.ceil(CODE_RESEND_SECONDS - sinceSent);
                    const windowEnds = row.window_started_at.getTime() + 3_600_000;
                    const sameWindow = windowEnds > now.getTime();
                    if (sameWindow && row.sends_in_window >= CODE_SENDS_PER_HOUR) return Math.ceil((windowEnds - now.getTime()) / 1000);
                    await client.query(
                        `UPDATE auth_codes
                         SET code_hash = $2, expires_at = $3, attempts = 0, sent_at = $4,
                             window_started_at = $5, sends_in_window = $6
                         WHERE target_hash = $1`,
                        [key, hashed, expiresAt, now, sameWindow ? row.window_started_at : now, sameWindow ? row.sends_in_window + 1 : 1],
                    );
                } else {
                    const inserted = await client.query(
                        `INSERT INTO auth_codes (target_hash, channel, code_hash, expires_at, sent_at, window_started_at, sends_in_window)
                         VALUES ($1, $2, $3, $4, $5, $5, 1) ON CONFLICT (target_hash) DO NOTHING`,
                        [key, channel.method, hashed, expiresAt, now],
                    );
                    // Another request for the same address got there first.
                    if (inserted.rowCount === 0) return CODE_RESEND_SECONDS;
                }
                // Sent inside the transaction, so a failed send doesn't use up the cooldown or limit.
                try {
                    await channel.sender.sendCode(target, code);
                } catch (error) {
                    request.log.error({ err: error, sender: channel.sender.label }, "sign-in code not sent");
                    throw channel.unavailable();
                }
                return undefined;
            });
            if (wait !== undefined) {
                reply.header("retry-after", String(wait));
                throw tooManyRequests("A code was sent recently. Wait a bit before asking for another.");
            }
            return reply.code(202).send({ expiresIn: CODE_SECONDS, resendAfter: CODE_RESEND_SECONDS });
        });

        app.post(`/${channel.method}/verify`, async (request) => {
            enabled(channel.method);
            const body = objectBody(request);
            const role = parseRole(body.role);
            const target = channel.parse(body[channel.field]);
            if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) throw invalidCode();
            const code = body.code;
            const key = targetHash(options.hashPepper, channel.method, target);
            const now = clock();

            // A wrong guess must be counted even though the request fails, so the transaction
            // returns the outcome instead of throwing.
            const outcome = await transaction(pool, async (client) => {
                const result = await client.query<{ code_hash: Buffer | null; expires_at: Date; attempts: number }>(
                    "SELECT code_hash, expires_at, attempts FROM auth_codes WHERE target_hash = $1 FOR UPDATE",
                    [key],
                );
                const row = result.rows[0];
                if (!row?.code_hash || row.expires_at <= now) return { ok: false as const };
                if (!timingSafeEqual(row.code_hash, codeHash(options.hashPepper, key, code))) {
                    await client.query(
                        `UPDATE auth_codes SET attempts = $2::int,
                             code_hash = CASE WHEN $2::int >= $3::int THEN NULL ELSE code_hash END
                         WHERE target_hash = $1`,
                        [key, row.attempts + 1, CODE_MAX_ATTEMPTS],
                    );
                    return { ok: false as const };
                }
                await client.query("UPDATE auth_codes SET code_hash = NULL WHERE target_hash = $1", [key]);
                // The address is proven by the code; a phone number is never stored.
                const email = channel.method === "email" ? target : undefined;
                return { ok: true as const, session: await signIn(pool, options, role, `${channel.method}:${key}`, email, client) };
            });
            if (!outcome.ok) throw invalidCode();
            return outcome.session;
        });
    }

    // Sessions ------------------------------------------------------------------------------

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
