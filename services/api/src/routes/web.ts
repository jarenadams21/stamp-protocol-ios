import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { addPunch, notifyRewardsWaiting } from "../cards.ts";
import { transaction } from "../db.ts";
import { ApiError, invalid } from "../errors.ts";
import type { ImageStore } from "../images.ts";
import {
    CODE_STARTS_PER_IP_PER_HOUR,
    codeChannels,
    parseEmail,
    parsePhoneNumber,
    RateLimiter,
    sendSignInCode,
    SIGN_INS_PER_IP_PER_HOUR,
    targetHash,
    useSignInCode,
    type CodeChannelName,
    type SignInOptions,
} from "../signIn.ts";
import type { TagVerifier } from "../tags.ts";
import type { Theme } from "../validation.ts";
import { nextStandLabel } from "./stands.ts";

// The website's diner routes (apps/web/docs/identity-and-api.md, docs/web-connect.md decision 2).
// Response shapes are the TypeScript types in apps/web/src/api/types.ts.
//
// A diner's first tap must work with no account, and a page shouldn't hold a refresh token in
// JavaScript, so a browser is identified by an HttpOnly cookie (`joeyy_web`: 32 random bytes, stored
// only as a SHA-256 hash in web_sessions) that points at a customer. A new browser gets an anonymous
// customer with subject `web:<uuid>`. Signing in with a phone or email code moves the browser to
// that number's or address's customer (the same subject the iOS app signs in to, see signIn.ts) and
// merges the anonymous cards into it. The page never sends a customer ID, and nothing here trusts one.
//
// Errors carry `code` as well as `error`, because the website reads `code`.

export interface WebOptions {
    pool: pg.Pool;
    images: ImageStore;
    tags: TagVerifier;
    /** Phone and email code sign-in. Without it those routes answer `503 signInUnavailable`. */
    signIn?: SignInOptions;
    /** Mark the cookie Secure. Off only with AUTH_MODE=dev, where the API runs on plain http://localhost. */
    secureCookie: boolean;
    /** Origins allowed to call with credentials (WEB_ORIGINS). Also checked on writes, against cross-site forms. */
    origins: string[];
}

const COOKIE = "joeyy_web";
const SESSION_SECONDS = 400 * 86_400;
const REDEEM_WINDOW_SECONDS = 120;
/** last_seen_at is written at most this often, so reads don't each cost a write. */
const SEEN_EVERY_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANONYMOUS = "web:";

const notFound = (message: string) => new ApiError(404, "notFound", message);
const expired = () => invalid("expired", "Ask for a new code.");
const invalidCode = () => invalid("invalidCode", "That code is wrong or has expired. Ask for a new one.");
const signInUnavailable = () => new ApiError(503, "signInUnavailable", "This sign-in option isn't available yet.");
const tooManyRequests = (message = "Too many tries. Wait a bit and try again.") => new ApiError(429, "tooManyRequests", message);

// Shapes (apps/web/src/api/types.ts) ---------------------------------------------------------

type Method = "phone" | "email" | "apple" | "google";

interface Identity {
    kind: "anonymous" | "account";
    method?: Method;
    maskedPhone?: string;
    maskedEmail?: string;
    displayName?: string;
}

interface Reward {
    rewardId: string;
    rewardDescription: string;
    earnedAt: string;
    redeemedAt?: string;
}

interface CardState {
    business: { id: string; name: string; location: string };
    program: {
        versionId: string;
        version: number;
        requiredPunches: number;
        rewardDescription: string;
        theme: Theme & { coverURL?: string };
        minMinutesBetweenStamps?: number;
    };
    card: { cardId: string; punches: number; requiredPunches: number; status: "active" | "completed" };
    rewardsAvailable: Reward[];
    recentVisits: string[];
}

interface SignInResult {
    identity: Identity;
    moved: { businessId: string; stamps: number }[];
    restoredCards: number;
    restoredRewards: number;
}

// Sessions -----------------------------------------------------------------------------------

interface SessionRow {
    id: string;
    customer_id: string;
    subject: string;
    email: string | null;
    display_name: string | null;
    signed_in_with: CodeChannelName | null;
    masked_phone: string | null;
    pending_channel: CodeChannelName | null;
    pending_target_hash: string | null;
    pending_masked: string | null;
    pending_email: string | null;
    last_seen_at: Date;
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest();

function cookieToken(request: FastifyRequest): string | undefined {
    for (const part of (request.headers.cookie ?? "").split(";")) {
        const [name, ...value] = part.trim().split("=");
        if (name !== COOKIE) continue;
        const token = value.join("=");
        return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
    }
    return undefined;
}

const SESSION_SELECT = `
    SELECT s.id, s.customer_id, c.subject, c.email, c.display_name, s.signed_in_with, s.masked_phone,
           s.pending_channel, s.pending_target_hash, s.pending_masked, s.pending_email, s.last_seen_at
    FROM web_sessions s JOIN customers c ON c.id = s.customer_id`;

async function sessionById(db: pg.Pool | pg.PoolClient, id: string): Promise<SessionRow> {
    const result = await db.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
    return result.rows[0]!;
}

/** This browser's session, or undefined for a browser with no cookie (or a stale or unknown one). */
async function loadSession(pool: pg.Pool, request: FastifyRequest): Promise<SessionRow | undefined> {
    const token = cookieToken(request);
    if (!token) return undefined;
    const result = await pool.query<SessionRow>(`${SESSION_SELECT} WHERE s.token_hash = $1 AND s.last_seen_at > $2`, [
        tokenHash(token),
        new Date(Date.now() - SESSION_SECONDS * 1000),
    ]);
    const session = result.rows[0];
    if (session && Date.now() - session.last_seen_at.getTime() > SEEN_EVERY_MS) {
        await pool.query("UPDATE web_sessions SET last_seen_at = now() WHERE id = $1", [session.id]);
    }
    return session;
}

/** A new anonymous customer and a session pointing at it. The caller sets the cookie after committing. */
async function newSession(client: pg.PoolClient): Promise<{ session: SessionRow; token: string }> {
    const customer = await client.query<{ id: string }>("INSERT INTO customers (subject) VALUES ($1) RETURNING id", [
        `${ANONYMOUS}${crypto.randomUUID()}`,
    ]);
    const token = randomBytes(32).toString("base64url");
    const inserted = await client.query<{ id: string }>("INSERT INTO web_sessions (token_hash, customer_id) VALUES ($1, $2) RETURNING id", [
        tokenHash(token),
        customer.rows[0]!.id,
    ]);
    return { session: await sessionById(client, inserted.rows[0]!.id), token };
}

const isAnonymous = (session: SessionRow) => session.subject.startsWith(ANONYMOUS);

/** "s•••@icloud.com" */
const maskEmail = (email: string) => email.replace(/^(.)[^@]*/, "$1•••");
/** "••• ••• 0123" */
const maskPhone = (number: string) => `••• ••• ${number.slice(-4)}`;

function identityOf(session: SessionRow): Identity {
    if (isAnonymous(session)) return { kind: "anonymous" };
    // How this browser signed in, or for an account it reached another way, how the account was made.
    const prefix = session.subject.split(":")[0] as Method;
    const method: Method = session.signed_in_with ?? (["phone", "email", "apple", "google"].includes(prefix) ? prefix : "phone");
    const identity: Identity = { kind: "account", method };
    if (method === "phone" && session.masked_phone) identity.maskedPhone = session.masked_phone;
    if (method !== "phone" && session.email) identity.maskedEmail = maskEmail(session.email);
    if (session.display_name) identity.displayName = session.display_name;
    return identity;
}

// Cards --------------------------------------------------------------------------------------

/** Each card's state for this customer, by business: their newest card there, its version's rules and look. */
async function cardStates(db: pg.Pool | pg.PoolClient, images: ImageStore, customerId: string, businessIds: string[] | null) {
    const cards = await db.query<{
        id: string;
        business_id: string;
        punches: number;
        status: "active" | "completed" | "closed";
        name: string;
        location: string;
        v_id: string;
        version: number;
        required_punches: number;
        reward_description: string;
        theme: Theme;
        cover_key: string | null;
        min_minutes_between_stamps: number | null;
    }>(
        `SELECT DISTINCT ON (c.business_id) c.id, c.business_id, c.punches, c.status, b.name, b.location,
                v.id AS v_id, v.version, v.required_punches, v.reward_description, v.theme, v.cover_key,
                v.min_minutes_between_stamps
         FROM cards c
         JOIN businesses b ON b.id = c.business_id
         JOIN program_versions v ON v.id = c.program_version_id
         WHERE c.customer_id = $1 AND ($2::uuid[] IS NULL OR c.business_id = ANY($2))
         ORDER BY c.business_id, (c.status = 'active') DESC, c.created_at DESC, c.id DESC`,
        [customerId, businessIds],
    );
    // The reward's description is the one its card promised, even if the business has changed it since.
    const rewards = await db.query<{ id: string; business_id: string; earned_at: Date; reward_description: string }>(
        `SELECT r.id, r.business_id, r.earned_at, v.reward_description
         FROM rewards r JOIN cards c ON c.id = r.card_id JOIN program_versions v ON v.id = c.program_version_id
         WHERE r.customer_id = $1 AND r.redeemed_at IS NULL AND ($2::uuid[] IS NULL OR r.business_id = ANY($2))
         ORDER BY r.earned_at, r.id`,
        [customerId, businessIds],
    );
    const visits = await db.query<{ business_id: string; occurred_at: Date }>(
        `SELECT business_id, occurred_at FROM (
             SELECT p.business_id, p.occurred_at,
                    ROW_NUMBER() OVER (PARTITION BY p.business_id ORDER BY p.occurred_at DESC, p.id DESC) AS n
             FROM punches p JOIN cards c ON c.id = p.card_id
             WHERE c.customer_id = $1 AND ($2::uuid[] IS NULL OR p.business_id = ANY($2))
         ) recent WHERE n <= 10
         ORDER BY occurred_at DESC`,
        [customerId, businessIds],
    );

    const states = new Map<string, CardState>();
    for (const row of cards.rows) {
        const coverURL = row.cover_key ? await images.url(row.cover_key) : undefined;
        states.set(row.business_id, {
            business: { id: row.business_id, name: row.name, location: row.location },
            program: {
                versionId: row.v_id,
                version: row.version,
                requiredPunches: row.required_punches,
                rewardDescription: row.reward_description,
                theme: coverURL ? { ...row.theme, coverURL } : row.theme,
                ...(row.min_minutes_between_stamps ? { minMinutesBetweenStamps: row.min_minutes_between_stamps } : {}),
            },
            card: {
                cardId: row.id,
                punches: row.punches,
                requiredPunches: row.required_punches,
                // A closed card (claimed early in the app) is full, like a completed one.
                status: row.status === "active" ? "active" : "completed",
            },
            rewardsAvailable: [],
            recentVisits: [],
        });
    }
    for (const row of rewards.rows) {
        states.get(row.business_id)?.rewardsAvailable.push({
            rewardId: row.id,
            rewardDescription: row.reward_description,
            earnedAt: row.earned_at.toISOString(),
        });
    }
    for (const row of visits.rows) states.get(row.business_id)?.recentVisits.push(row.occurred_at.toISOString());
    return states;
}

async function cardState(db: pg.Pool | pg.PoolClient, images: ImageStore, customerId: string, businessId: string) {
    return (await cardStates(db, images, customerId, [businessId])).get(businessId);
}

async function businessJSON(db: pg.Pool | pg.PoolClient, businessId: string) {
    const result = await db.query<{ id: string; name: string; location: string }>("SELECT id, name, location FROM businesses WHERE id = $1", [
        businessId,
    ]);
    return result.rows[0];
}

/** The short code on the staff screen: the reward ID's last four letters and digits. */
const redemptionCode = (rewardId: string) => rewardId.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();

// Sign-in merge -------------------------------------------------------------------------------

/**
 * Moves an anonymous customer's cards into an account (identity-and-api.md, merge rules): each
 * anonymous stamp counts once and goes onto the account's card for that business; a card that fills
 * earns its reward and extra stamps start the next card; every reward is kept. Full cards keep their
 * own rewards and move as they are, since their stamps already paid for those rewards.
 */
async function mergeInto(client: pg.PoolClient, fromId: string, toId: string): Promise<SignInResult["moved"]> {
    const moved: SignInResult["moved"] = [];
    const cards = await client.query<{ id: string; business_id: string; punches: number; status: string }>(
        `SELECT id, business_id, punches, status FROM cards WHERE customer_id = $1
         ORDER BY business_id, (status = 'active') DESC, created_at DESC`,
        [fromId],
    );
    const businesses = [...new Set(cards.rows.map((card) => card.business_id))];
    for (const businessId of businesses) {
        const theirs = cards.rows.filter((card) => card.business_id === businessId);
        const newest = theirs[0]!;
        const open = theirs.find((card) => card.status === "active");
        const existing = await client.query("SELECT 1 FROM cards WHERE customer_id = $1 AND business_id = $2 LIMIT 1", [toId, businessId]);
        if (existing.rowCount === 0) {
            // Nothing there yet: the cards simply change hands.
            await client.query("UPDATE cards SET customer_id = $1 WHERE customer_id = $2 AND business_id = $3", [toId, fromId, businessId]);
            await client.query("UPDATE rewards SET customer_id = $1 WHERE customer_id = $2 AND business_id = $3", [toId, fromId, businessId]);
            if (newest.punches > 0) moved.push({ businessId, stamps: newest.punches });
            continue;
        }
        await client.query("UPDATE cards SET customer_id = $1 WHERE customer_id = $2 AND business_id = $3 AND status <> 'active'", [
            toId,
            fromId,
            businessId,
        ]);
        await client.query("UPDATE rewards SET customer_id = $1 WHERE customer_id = $2 AND business_id = $3", [toId, fromId, businessId]);
        if (!open) continue;
        // Replay each stamp of the open card onto the account, through the same lifecycle as a tap.
        const punches = await client.query<{ id: string; occurred_at: Date }>(
            "SELECT id, occurred_at FROM punches WHERE card_id = $1 ORDER BY occurred_at, id",
            [open.id],
        );
        for (const punch of punches.rows) {
            await addPunch(client, toId, businessId, { move: { punchId: punch.id, occurredAt: punch.occurred_at } });
        }
        if (punches.rows.length > 0) moved.push({ businessId, stamps: punches.rows.length });
        await client.query("DELETE FROM cards WHERE id = $1", [open.id]);
    }
    // Used windows keep their history; an open one moves unless the account has its own there.
    await client.query(
        `UPDATE redeem_intents i SET customer_id = $1
         WHERE i.customer_id = $2 AND (i.used_at IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM redeem_intents o WHERE o.customer_id = $1 AND o.business_id = i.business_id AND o.used_at IS NULL))`,
        [toId, fromId],
    );
    // The account's card order wins; this browser's only counts if the account never set one.
    await client.query("UPDATE customers SET card_order = COALESCE(card_order, (SELECT card_order FROM customers WHERE id = $2)) WHERE id = $1", [
        toId,
        fromId,
    ]);
    return moved;
}

/**
 * Signs this browser in to the account with `subject`, the same subject the apps get from
 * /v1/auth for that number or address. New to JOEYY and this browser is anonymous: the browser's
 * customer simply becomes the account. Otherwise the browser moves to the account, merging its
 * anonymous cards first. A browser already signed in to another account just moves.
 */
async function signInBrowser(
    client: pg.PoolClient,
    session: SessionRow,
    subject: string,
    method: CodeChannelName,
    detail: { email?: string; maskedPhone?: string },
): Promise<SignInResult> {
    const now = new Date();
    await client.query("SELECT 1 FROM customers WHERE id = $1 FOR UPDATE", [session.customer_id]);
    const account = await client.query<{ id: string }>("SELECT id FROM customers WHERE subject = $1 FOR UPDATE", [subject]);
    let accountId = account.rows[0]?.id;
    let moved: SignInResult["moved"] = [];
    let restoredCards = 0;
    let restoredRewards = 0;
    const anonymous = isAnonymous(session);

    if (!accountId && anonymous) {
        await client.query("UPDATE customers SET subject = $2, email = COALESCE($3, email), last_sign_in_at = $4 WHERE id = $1", [
            session.customer_id,
            subject,
            detail.email ?? null,
            now,
        ]);
        accountId = session.customer_id;
    } else {
        if (accountId) {
            await client.query("UPDATE customers SET email = COALESCE($2, email), last_sign_in_at = $3 WHERE id = $1", [
                accountId,
                detail.email ?? null,
                now,
            ]);
        } else {
            const created = await client.query<{ id: string }>(
                "INSERT INTO customers (subject, email, last_sign_in_at) VALUES ($1, $2, $3) RETURNING id",
                [subject, detail.email ?? null, now],
            );
            accountId = created.rows[0]!.id;
        }
        if (accountId !== session.customer_id) {
            const counts = await client.query<{ cards: number; rewards: number }>(
                `SELECT (SELECT COUNT(DISTINCT business_id) FROM cards WHERE customer_id = $1)::int AS cards,
                        (SELECT COUNT(*) FROM rewards WHERE customer_id = $1 AND redeemed_at IS NULL)::int AS rewards`,
                [accountId],
            );
            restoredCards = counts.rows[0]!.cards;
            restoredRewards = counts.rows[0]!.rewards;
            if (anonymous) moved = await mergeInto(client, session.customer_id, accountId);
        }
    }

    await client.query(
        `UPDATE web_sessions SET customer_id = $2, signed_in_with = $3, masked_phone = $4,
             pending_channel = NULL, pending_target_hash = NULL, pending_masked = NULL, pending_email = NULL
         WHERE id = $1`,
        [session.id, accountId, method, detail.maskedPhone ?? null],
    );
    // The anonymous customer is now empty; its intents still pointing at it go with it.
    if (anonymous && accountId !== session.customer_id) await client.query("DELETE FROM customers WHERE id = $1", [session.customer_id]);
    return { identity: identityOf(await sessionById(client, session.id)), moved, restoredCards, restoredRewards };
}

// Input --------------------------------------------------------------------------------------

function objectBody(request: FastifyRequest): Record<string, unknown> {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("invalidBody", "The request body couldn't be read.");
    return body as Record<string, unknown>;
}

/**
 * The page sends the number as the diner typed it. With country code 1 allowed, a 10-digit number
 * (or 11 starting with 1) is read as North American, like the demo; otherwise it needs a "+".
 * Normalized to E.164 exactly as /v1/auth does, so both reach the same account.
 */
function parseWebPhone(value: unknown, countryCodes: string[]): string {
    const fail = () => invalid("invalidPhone", "Enter a valid mobile number.");
    if (typeof value !== "string") throw fail();
    let number = value.replace(/[\s().-]/g, "");
    if (!number.startsWith("+") && countryCodes.includes("1")) {
        if (/^\d{10}$/.test(number)) number = `+1${number}`;
        else if (/^1\d{10}$/.test(number)) number = `+${number}`;
    }
    try {
        return parsePhoneNumber(number, countryCodes);
    } catch {
        throw fail();
    }
}

/** Letters, marks, digits, spaces and a little punctuation: no control characters, links or emoji walls. */
function parseDisplayName(value: unknown): string | null {
    if (typeof value !== "string") throw invalid("invalidName", "Use up to 40 letters.");
    const name = value.normalize("NFC").replace(/\s+/g, " ").trim();
    if ([...name].length > 40 || /[^\p{L}\p{M}\p{N} '’.\-]/u.test(name)) throw invalid("invalidName", "Use up to 40 letters.");
    return name || null;
}

// Routes -------------------------------------------------------------------------------------

export async function webRoutes(app: FastifyInstance, options: WebOptions) {
    const { pool, images, tags, signIn } = options;
    const perIp = new RateLimiter(SIGN_INS_PER_IP_PER_HOUR, 3_600_000);
    const codeStartsPerIp = new RateLimiter(CODE_STARTS_PER_IP_PER_HOUR, 3_600_000);

    const cookie = (value: string, maxAge: number) =>
        `${COOKIE}=${value}; Path=/v1/web; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${options.secureCookie ? "; Secure" : ""}`;
    const setCookie = (reply: FastifyReply, token: string) => reply.header("set-cookie", cookie(token, SESSION_SECONDS));
    const clearCookie = (reply: FastifyReply) => reply.header("set-cookie", cookie("", 0));

    const limit = (limiter: RateLimiter, request: FastifyRequest, reply: FastifyReply) => {
        const wait = limiter.hit(request.ip);
        if (wait !== undefined) {
            reply.header("retry-after", String(wait));
            throw tooManyRequests();
        }
    };

    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ApiError) return reply.code(error.status).send({ error: error.code, code: error.code, message: error.message });
        throw error; // The app's own handler maps the rest.
    });

    app.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        // SameSite=Lax keeps the cookie off cross-site POSTs; this also turns away a form posted from
        // another origin on the same site. Requests with no Origin (curl, same-origin GETs) pass.
        const origin = request.headers.origin;
        if (origin && request.method !== "GET" && request.method !== "HEAD" && !options.origins.includes(origin)) {
            let sameHost = false;
            try {
                sameHost = new URL(origin).host === request.headers.host;
            } catch {
                sameHost = false;
            }
            if (!sameHost) throw new ApiError(403, "forbiddenOrigin", "This site can't do that.");
        }
    });

    // Taps ---------------------------------------------------------------------------------

    app.post("/taps", async (request, reply) => {
        const body = objectBody(request);
        const tap = tags.verify(body.picc, body.cmac);
        if (!tap) return { outcome: "invalidTag" };
        const existing = await loadSession(pool, request);
        let newToken: string | undefined;

        const result = await transaction(pool, async (client) => {
            const now = new Date();
            // The one statement that stops replays: the counter is accepted only if it beats the last.
            const accepted = await client.query<{ id: string; business_id: string; status: "allocated" | "active" | "disabled" }>(
                `UPDATE readers SET last_counter = $2, last_tap_at = $3
                 WHERE kind = 'stand' AND tag_uid = $1 AND last_counter < $2
                 RETURNING id, business_id, status`,
                [tap.tagUid, tap.counter, now],
            );
            const stand = accepted.rows[0];
            if (!stand) {
                const known = await client.query<{ business_id: string }>("SELECT business_id FROM readers WHERE kind = 'stand' AND tag_uid = $1", [
                    tap.tagUid,
                ]);
                const businessId = known.rows[0]?.business_id;
                if (!businessId) return { outcome: "invalidTag" };
                const state = existing ? await cardState(client, images, existing.customer_id, businessId) : undefined;
                return state ? { outcome: "replayed", state } : { outcome: "replayed" };
            }

            if (stand.status === "allocated") {
                // The owner's pairing window turns the first tap on one of their stands into linking it.
                const business = await client.query<{ pairing_expires_at: Date | null; current_version_id: string | null }>(
                    "SELECT pairing_expires_at, current_version_id FROM businesses WHERE id = $1 FOR UPDATE",
                    [stand.business_id],
                );
                const row = business.rows[0]!;
                if (row.pairing_expires_at && row.pairing_expires_at > now && row.current_version_id) {
                    await client.query("UPDATE readers SET status = 'active', activated_at = $2, label = $3 WHERE id = $1", [
                        stand.id,
                        now,
                        await nextStandLabel(client, stand.business_id),
                    ]);
                    await client.query("UPDATE businesses SET pairing_expires_at = NULL WHERE id = $1", [stand.business_id]);
                    return { outcome: "standLinked", business: await businessJSON(client, stand.business_id) };
                }
                return { outcome: "tagNotActive", business: await businessJSON(client, stand.business_id) };
            }
            if (stand.status === "disabled") return { outcome: "tagDisabled", business: await businessJSON(client, stand.business_id) };

            let session = existing;
            if (!session) {
                const created = await newSession(client);
                session = created.session;
                newToken = created.token;
            }
            const customerId = session.customer_id;
            // Serializes this customer's taps, so two at once can't both open or roll over a card.
            await client.query("SELECT 1 FROM customers WHERE id = $1 FOR UPDATE", [customerId]);
            const identity = identityOf(session);

            // An open redeem window turns this tap into the redemption instead of a stamp.
            const intent = await client.query<{ id: string; reward_id: string }>(
                `SELECT i.id, i.reward_id FROM redeem_intents i JOIN rewards r ON r.id = i.reward_id
                 WHERE i.customer_id = $1 AND i.business_id = $2 AND i.used_at IS NULL AND i.expires_at > $3 AND r.redeemed_at IS NULL
                 FOR UPDATE OF i, r`,
                [customerId, stand.business_id, now],
            );
            const open = intent.rows[0];
            if (open) {
                const code = redemptionCode(open.reward_id);
                await client.query("UPDATE rewards SET redeemed_at = $2 WHERE id = $1", [open.reward_id, now]);
                await client.query("UPDATE redeem_intents SET used_at = $2, code = $3 WHERE id = $1", [open.id, now, code]);
                await notifyRewardsWaiting(client, stand.business_id);
                const description = await client.query<{ reward_description: string }>(
                    `SELECT v.reward_description FROM rewards r JOIN cards c ON c.id = r.card_id
                     JOIN program_versions v ON v.id = c.program_version_id WHERE r.id = $1`,
                    [open.reward_id],
                );
                return {
                    outcome: "redeemed",
                    state: await cardState(client, images, customerId, stand.business_id),
                    redemption: {
                        rewardId: open.reward_id,
                        rewardDescription: description.rows[0]!.reward_description,
                        redeemedAt: now.toISOString(),
                        code,
                        intentId: open.id,
                    },
                    identity,
                };
            }

            // No built-in limit on repeat taps; only the business's own minimum gap, if it set one.
            const limitRow = await client.query<{ minutes: number | null; last: Date | null }>(
                `SELECT v.min_minutes_between_stamps AS minutes,
                        (SELECT MAX(p.occurred_at) FROM punches p JOIN cards c ON c.id = p.card_id
                         WHERE c.customer_id = $2 AND p.business_id = $1) AS last
                 FROM businesses b LEFT JOIN program_versions v ON v.id = b.current_version_id
                 WHERE b.id = $1`,
                [stand.business_id, customerId],
            );
            const { minutes, last } = limitRow.rows[0]!;
            if (minutes && last && now.getTime() - last.getTime() < minutes * 60_000) {
                const state = await cardState(client, images, customerId, stand.business_id);
                if (state) {
                    return { outcome: "cooldown", state, nextStampAt: new Date(last.getTime() + minutes * 60_000).toISOString(), identity };
                }
            }

            const punch = await addPunch(client, customerId, stand.business_id, {
                insert: { readerId: stand.id, eventId: `tag:${tap.tagUid}:${tap.counter}`, occurredAt: now },
            });
            // An active stand whose business has no live card can't happen through the API; say so plainly if it does.
            if (!punch) return { outcome: "tagNotActive", business: await businessJSON(client, stand.business_id) };
            const state = await cardState(client, images, customerId, stand.business_id);
            if (punch.rewardId) {
                const reward = state!.rewardsAvailable.find((item) => item.rewardId === punch.rewardId)!;
                return { outcome: "completed", state, reward, identity };
            }
            return { outcome: "stamped", state, startedNewCard: punch.startedNewCard, identity };
        });
        if (newToken) setCookie(reply, newToken);
        return result;
    });

    // Cards --------------------------------------------------------------------------------

    app.get("/me/cards", async (request) => {
        const session = await loadSession(pool, request);
        if (!session) return { identity: { kind: "anonymous" }, cards: [] };
        const states = await cardStates(pool, images, session.customer_id, null);
        const order = await pool.query<{ card_order: string[] | null }>("SELECT card_order FROM customers WHERE id = $1", [session.customer_id]);
        const chosen = order.rows[0]?.card_order ?? [];
        // The diner's own order first; cards it doesn't list follow, most recent visit first.
        const rank = (businessId: string) => {
            const index = chosen.indexOf(businessId);
            return index === -1 ? Number.MAX_SAFE_INTEGER : index;
        };
        const lastVisit = (state: CardState) => state.recentVisits[0] ?? "";
        const cards = [...states.values()].sort(
            (a, b) =>
                rank(a.business.id) - rank(b.business.id) ||
                lastVisit(b).localeCompare(lastVisit(a)) ||
                a.business.name.localeCompare(b.business.name),
        );
        return { identity: identityOf(session), cards };
    });

    app.get<{ Params: { businessId: string } }>("/me/cards/:businessId", async (request) => {
        const session = await loadSession(pool, request);
        const { businessId } = request.params;
        const state = session && UUID.test(businessId) ? await cardState(pool, images, session.customer_id, businessId.toLowerCase()) : undefined;
        if (!state) throw notFound("No card here yet.");
        return state;
    });

    app.put("/me/cards/order", async (request, reply) => {
        const body = objectBody(request);
        if (!Array.isArray(body.businessIds)) throw invalid("invalidBody", "businessIds must be a list.");
        const session = await loadSession(pool, request);
        // Unknown or malformed IDs are dropped; cards the list leaves out fall back to most recent visit.
        const ids = [...new Set(body.businessIds.filter((id): id is string => typeof id === "string" && UUID.test(id)).map((id) => id.toLowerCase()))].slice(
            0,
            200,
        );
        if (session) {
            await pool.query(
                `UPDATE customers SET card_order = ARRAY(
                     SELECT id FROM unnest($2::uuid[]) WITH ORDINALITY AS chosen (id, n)
                     WHERE EXISTS (SELECT 1 FROM businesses b WHERE b.id = chosen.id) ORDER BY n)
                 WHERE id = $1`,
                [session.customer_id, ids],
            );
        }
        return reply.code(204).send();
    });

    // Redeem windows -----------------------------------------------------------------------

    app.post("/redeem-intents", async (request) => {
        const body = objectBody(request);
        const session = await loadSession(pool, request);
        const rewardId = typeof body.rewardId === "string" && UUID.test(body.rewardId) ? body.rewardId.toLowerCase() : undefined;
        if (!session || !rewardId) throw notFound("This reward is already used.");
        return transaction(pool, async (client) => {
            const reward = await client.query<{ business_id: string }>(
                "SELECT business_id FROM rewards WHERE id = $1 AND customer_id = $2 AND redeemed_at IS NULL FOR UPDATE",
                [rewardId, session.customer_id],
            );
            const businessId = reward.rows[0]?.business_id;
            if (!businessId) throw notFound("This reward is already used.");
            // One open window per business: starting again replaces the last one.
            await client.query("DELETE FROM redeem_intents WHERE customer_id = $1 AND business_id = $2 AND used_at IS NULL", [
                session.customer_id,
                businessId,
            ]);
            const now = new Date();
            const created = await client.query<{ id: string; expires_at: Date }>(
                `INSERT INTO redeem_intents (customer_id, business_id, reward_id, created_at, expires_at)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id, expires_at`,
                [session.customer_id, businessId, rewardId, now, new Date(now.getTime() + REDEEM_WINDOW_SECONDS * 1000)],
            );
            const intent = created.rows[0]!;
            return { intentId: intent.id, rewardId, businessId, expiresAt: intent.expires_at.toISOString() };
        });
    });

    app.get<{ Params: { intentId: string } }>("/redeem-intents/:intentId", async (request) => {
        const session = await loadSession(pool, request);
        const { intentId } = request.params;
        if (!session || !UUID.test(intentId)) throw notFound("This window has closed.");
        // Only the browser that opened it can read it: the waiting page and the staff screen both live there.
        const result = await pool.query<{
            id: string;
            reward_id: string;
            business_id: string;
            expires_at: Date;
            used_at: Date | null;
            code: string | null;
            reward_description: string;
        }>(
            `SELECT i.id, i.reward_id, i.business_id, i.expires_at, i.used_at, i.code, v.reward_description
             FROM redeem_intents i JOIN rewards r ON r.id = i.reward_id JOIN cards c ON c.id = r.card_id
             JOIN program_versions v ON v.id = c.program_version_id
             WHERE i.id = $1 AND i.customer_id = $2`,
            [intentId.toLowerCase(), session.customer_id],
        );
        const row = result.rows[0];
        if (!row) throw notFound("This window has closed.");
        const intent = { intentId: row.id, rewardId: row.reward_id, businessId: row.business_id, expiresAt: row.expires_at.toISOString() };
        if (!row.used_at || !row.code) return { intent };
        return {
            intent,
            redemption: {
                rewardId: row.reward_id,
                rewardDescription: row.reward_description,
                redeemedAt: row.used_at.toISOString(),
                code: row.code,
                intentId: row.id,
            },
        };
    });

    app.delete<{ Params: { intentId: string } }>("/redeem-intents/:intentId", async (request, reply) => {
        const session = await loadSession(pool, request);
        const { intentId } = request.params;
        if (session && UUID.test(intentId)) {
            await pool.query("DELETE FROM redeem_intents WHERE id = $1 AND customer_id = $2 AND used_at IS NULL", [
                intentId.toLowerCase(),
                session.customer_id,
            ]);
        }
        return reply.code(204).send();
    });

    // Sign-in with a code ------------------------------------------------------------------

    const channels = signIn ? codeChannels(signIn) : [];
    for (const method of ["phone", "email"] as const) {
        const field = method === "phone" ? "phone" : "email";

        app.post(`/${method}/start`, async (request, reply) => {
            const channel = channels.find((item) => item.method === method);
            if (!signIn || !channel || !signIn.methods.includes(method)) throw signInUnavailable();
            limit(perIp, request, reply);
            const body = objectBody(request);
            const target =
                method === "phone"
                    ? parseWebPhone(body[field], signIn.phoneCountryCodes)
                    : (() => {
                          try {
                              return parseEmail(body[field]);
                          } catch {
                              throw invalid("invalidEmail", "Enter a valid email address.");
                          }
                      })();
            limit(codeStartsPerIp, request, reply);

            let session = await loadSession(pool, request);
            if (!session) {
                const created = await transaction(pool, newSession);
                session = created.session;
                setCookie(reply, created.token);
            }
            const wait = await sendSignInCode(pool, signIn, channel, target, request);
            if (wait !== undefined) {
                reply.header("retry-after", String(wait));
                throw tooManyRequests("A code was sent recently. Wait a bit before asking for another.");
            }
            const masked = method === "phone" ? maskPhone(target) : maskEmail(target);
            await pool.query(
                `UPDATE web_sessions SET pending_channel = $2, pending_target_hash = $3, pending_masked = $4, pending_email = $5
                 WHERE id = $1`,
                [session.id, method, targetHash(signIn.hashPepper, method, target), masked, method === "email" ? target : null],
            );
            return method === "phone" ? { maskedPhone: masked } : { maskedEmail: masked };
        });

        app.post(`/${method}/verify`, async (request, reply) => {
            if (!signIn || !signIn.methods.includes(method)) throw signInUnavailable();
            limit(perIp, request, reply);
            const body = objectBody(request);
            const session = await loadSession(pool, request);
            if (!session || session.pending_channel !== method || !session.pending_target_hash) throw expired();
            const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
            if (!/^\d{6}$/.test(code)) throw invalidCode();
            const key = session.pending_target_hash;

            // A wrong guess must be counted even though the request fails, so the transaction
            // returns the outcome instead of throwing.
            const outcome = await transaction(pool, async (client) => {
                if (!(await useSignInCode(client, signIn, key, code))) return undefined;
                return signInBrowser(client, session, `${method}:${key}`, method, {
                    email: session.pending_email ?? undefined,
                    maskedPhone: method === "phone" ? (session.pending_masked ?? undefined) : undefined,
                });
            });
            if (!outcome) throw invalidCode();
            return outcome;
        });
    }

    app.post("/sign-out", async (request, reply) => {
        const token = cookieToken(request);
        // The account keeps everything; only this browser's session ends. An anonymous browser's
        // cards stay with its customer row, out of reach, so the businesses' counts don't change.
        if (token) await pool.query("DELETE FROM web_sessions WHERE token_hash = $1", [tokenHash(token)]);
        clearCookie(reply);
        return reply.code(204).send();
    });

    // Profile and account ------------------------------------------------------------------

    app.put("/me/profile", async (request) => {
        const body = objectBody(request);
        const session = await loadSession(pool, request);
        // A name needs somewhere lasting to live, so not for an anonymous browser.
        if (!session || isAnonymous(session)) throw notFound("Sign in to add a name.");
        const name = parseDisplayName(body.displayName);
        await pool.query("UPDATE customers SET display_name = $2 WHERE id = $1", [session.customer_id, name]);
        return identityOf({ ...session, display_name: name });
    });

    app.delete("/me", async (request, reply) => {
        const session = await loadSession(pool, request);
        if (!session || isAnonymous(session)) throw notFound("No account to delete.");
        await transaction(pool, async (client) => {
            // The apps' sessions for this account stop working too.
            await client.query("UPDATE auth_refresh_tokens SET revoked_at = now() WHERE audience = 'customer' AND subject = $1 AND revoked_at IS NULL", [
                session.subject,
            ]);
            // Cascades to its cards, punches, rewards, redeem windows, and every browser signed in to it.
            await client.query("DELETE FROM customers WHERE id = $1", [session.customer_id]);
        });
        clearCookie(reply);
        return reply.code(204).send();
    });
}
