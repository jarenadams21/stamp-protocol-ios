import { randomBytes, randomUUID, createHash, scrypt as derive, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { transaction } from "../db.ts";
import { HttpError } from "../../support.mjs";

const scrypt = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
    derive(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
});
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function normalizeUUID(value: string): string {
    if (!uuidPattern.test(value)) throw new HttpError(400, "Invalid identifier.");
    return value.toLowerCase();
}
type Queryable = pg.Pool | pg.PoolClient;
export interface NativeCard {
    id: string;
    cafeId: string;
    cafeName: string;
    stamps: number;
    target: number;
    rewardsAvailable: number;
    updatedAt: string;
    version: string;
}
export interface NativeCustomer { id: string; username: string; sessionHash: string }
export interface VerifiedTag { uid: string; counter: number }
interface EventRow { id: string; card_id: string; fingerprint: string }
interface CustomerRow { id: string; username: string; salt: string; password_hash: string }
export const publicCard = ({ version: _version, ...card }: NativeCard) => card;

export class NativeStore {
    readonly pool: pg.Pool;
    constructor(pool: pg.Pool) { this.pool = pool; }

    credentials(username: unknown, password: unknown): { username: string; password: string } {
        if (typeof username !== "string" || !/^[a-zA-Z0-9._-]{3,40}$/.test(username) ||
            typeof password !== "string" || password.length < 12 || password.length > 128) {
            throw new HttpError(400, "Use a 3-40 character username (letters, numbers, . _ -) and a 12-128 character password.");
        }
        return { username: username.toLowerCase(), password };
    }

    async signup(rawUsername: unknown, rawPassword: unknown) {
        const { username, password } = this.credentials(rawUsername, rawPassword);
        const salt = randomBytes(16).toString("hex");
        const hash = (await scrypt(password, salt)).toString("hex");
        return transaction(this.pool, async (db) => {
            const id = randomUUID();
            const inserted = await db.query(
                `INSERT INTO native_customers(id,username,salt,password_hash) VALUES($1,$2,$3,$4)
                 ON CONFLICT(username) DO NOTHING RETURNING id`, [id, username, salt, hash]);
            if (!inserted.rowCount) throw new HttpError(409, "That username is already taken.");
            return this.session(db, id, username);
        });
    }

    async login(rawUsername: unknown, rawPassword: unknown) {
        const { username, password } = this.credentials(rawUsername, rawPassword);
        const { rows: [customer] } = await this.pool.query<CustomerRow>("SELECT * FROM native_customers WHERE username=$1", [username]);
        const hash = await scrypt(password, customer?.salt ?? "unknown-account-salt");
        const expected = customer ? Buffer.from(customer.password_hash, "hex") : Buffer.alloc(64);
        if (hash.length !== expected.length || !timingSafeEqual(hash, expected) || !customer) {
            throw new HttpError(401, "Incorrect username or password.");
        }
        return this.session(this.pool, customer.id, customer.username);
    }

    private async session(db: Queryable, id: string, username: string) {
        const token = randomBytes(32).toString("hex");
        await db.query("INSERT INTO native_sessions(hash,customer_id,expires) VALUES($1,$2,$3)",
            [digest(token), id, Date.now() + 30 * 86400_000]);
        return { token, username };
    }

    async authenticate(header: string | undefined): Promise<NativeCustomer> {
        if (!header || !/^Bearer [0-9a-f]{64}$/.test(header)) throw new HttpError(401, "Please sign in.");
        const hash = digest(header.slice(7));
        const { rows: [row] } = await this.pool.query<{ id: string; username: string }>(
            `SELECT c.id,c.username FROM native_sessions s JOIN native_customers c ON c.id=s.customer_id
             WHERE s.hash=$1 AND s.expires>$2`, [hash, Date.now()]);
        if (!row) throw new HttpError(401, "Your session expired. Please sign in.");
        return { ...row, sessionHash: hash };
    }

    async logout(customer: NativeCustomer) {
        await this.pool.query("DELETE FROM native_sessions WHERE hash=$1", [customer.sessionHash]);
    }

    async card(id: string, customerId?: string, db: Queryable = this.pool): Promise<NativeCard> {
        const { rows: [row] } = await db.query<NativeCard>(
            `SELECT c.id,c.cafe_id AS "cafeId",f.name AS "cafeName",c.stamps,f.target,
                    c.rewards AS "rewardsAvailable",c.updated_at AS "updatedAt",c.version::text
             FROM native_cards c JOIN native_cafes f ON f.id=c.cafe_id WHERE c.id=$1
             AND ($2::uuid IS NULL OR c.customer_id=$2)`, [normalizeUUID(id), customerId ?? null]);
        if (!row) throw new HttpError(404, "Card not found.");
        return row;
    }

    async cards(customerId: string) {
        const { rows } = await this.pool.query<{ id: string }>("SELECT id FROM native_cards WHERE customer_id=$1 ORDER BY updated_at DESC,id", [customerId]);
        return Promise.all(rows.map(({ id }) => this.card(id, customerId)));
    }

    async previous(customerId: string, requestId: string, url: string, db: Queryable = this.pool) {
        const { rows: [row] } = await db.query<EventRow>(
            "SELECT id,card_id,fingerprint FROM native_events WHERE customer_id=$1 AND request_id=$2", [customerId, requestId]);
        if (row && row.fingerprint !== digest(url)) throw new HttpError(409, "This request ID was already used for a different tap.");
        return row;
    }

    async award(customerId: string, requestId: string, url: string, verified?: VerifiedTag) {
        return transaction(this.pool, async (db) => {
            // Cross-process customer serialization makes the request-id decision atomic,
            // including two different chips using the same request ID concurrently.
            await db.query("SELECT id FROM native_customers WHERE id=$1 FOR UPDATE", [customerId]);
            const previous = await this.previous(customerId, requestId, url, db);
            if (previous) return { eventId: previous.id, card: await this.card(previous.card_id, customerId, db), duplicate: true };
            if (!verified) throw new HttpError(409, "Scan the physical chip again.");
            if (!/^[0-9A-F]{14}$/.test(verified.uid) || !Number.isInteger(verified.counter) ||
                verified.counter < 0 || verified.counter > 0xffffff) throw new HttpError(502, "Invalid verifier response.");
            const { rows: [tag] } = await db.query<{ cafe_id: string; last_counter: number }>(
                "SELECT cafe_id,last_counter FROM native_tags WHERE uid=$1 FOR UPDATE", [verified.uid]);
            if (!tag) throw new HttpError(409, "This chip has not been linked to a cafe. Ask the operator to link it.");
            if (verified.counter <= tag.last_counter) throw new HttpError(409, "This tap link was already used. Scan the physical chip again.");
            await db.query(
                `INSERT INTO native_cards(id,customer_id,cafe_id,stamps,updated_at) VALUES($1,$2,$3,0,$4)
                 ON CONFLICT(customer_id,cafe_id) DO NOTHING`, [randomUUID(), customerId, tag.cafe_id, new Date().toISOString()]);
            const { rows: [locked] } = await db.query<{ id: string }>(
                "SELECT id FROM native_cards WHERE customer_id=$1 AND cafe_id=$2 FOR UPDATE", [customerId, tag.cafe_id]);
            if (!locked) throw new Error("Missing native card");
            const card = await this.card(locked.id, customerId, db);
            const stamps = card.stamps >= card.target ? 1 : card.stamps + 1;
            const id = randomUUID();
            const { rows: [event] } = await db.query<{ seq: string }>(
                `INSERT INTO native_events(id,customer_id,request_id,fingerprint,card_id,uid,counter)
                 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING seq::text`,
                [id, customerId, requestId, digest(url), card.id, verified.uid, verified.counter]);
            if (!event) throw new Error("Missing native event");
            await db.query("UPDATE native_tags SET last_counter=$1 WHERE uid=$2", [verified.counter, verified.uid]);
            await db.query("UPDATE native_cards SET stamps=$1,rewards=$2,updated_at=$3,version=$4 WHERE id=$5",
                [stamps, card.rewardsAvailable + (stamps === card.target ? 1 : 0), new Date().toISOString(), event.seq, card.id]);
            return { eventId: id, card: await this.card(card.id, customerId, db), duplicate: false };
        });
    }
}
