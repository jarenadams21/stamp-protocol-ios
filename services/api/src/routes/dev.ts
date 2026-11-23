import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { verifyBearer, type AuthConfig } from "../auth.ts";
import { transaction } from "../db.ts";
import { ApiError } from "../errors.ts";
import { requireBusiness } from "./partner.ts";
import { nextStandLabel, standCredentialHash, standsJSON } from "./stands.ts";

// Development only (docs/web-connect.md): registered when AUTH_MODE=dev, and the routes don't exist
// otherwise. They stand in for what needs hardware or the warehouse: packing a stand for a business,
// the owner's phone touching it, and a diner's phone reading a fresh SUN message from it.

const standNotFound = () => new ApiError(404, "standNotFound", "No stand has this tag.");

/** A real NTAG 424 DNA UID: 7 bytes, as the tag check reports it (upper-case hex). */
const REAL_UID = /^[0-9A-F]{14}$/;

async function allocate(
    client: pg.PoolClient | pg.Pool,
    businessId: string,
    status: "allocated" | "active",
    label: string | null,
    tagUid = `dev-${randomBytes(6).toString("hex")}`,
) {
    const taken = await client.query("SELECT 1 FROM readers WHERE tag_uid = $1", [tagUid]);
    if (taken.rowCount) throw new ApiError(409, "standTaken", "That tag is already allocated to a business.");
    await client.query(
        `INSERT INTO readers (business_id, kind, tag_uid, status, credential_hash, label, activated_at)
         VALUES ($1, 'stand', $2, $3, $4, $5, $6)`,
        [businessId, tagUid, status, standCredentialHash(tagUid), label, status === "active" ? new Date() : null],
    );
    return tagUid;
}

export async function devRoutes(app: FastifyInstance, options: { pool: pg.Pool; auth: AuthConfig }) {
    const { pool, auth } = options;

    /**
     * Allocates a stand to the owner's business, as packing one for them would. Body `{ tagUid }`
     * allocates a real tag by its 14-hex-digit UID (then the owner links it with a real tap while
     * pairing is open); without it, a made-up dev tag.
     */
    app.post("/stands", async (request, reply) => {
        const subject = await verifyBearer(auth, request.headers.authorization, "partner");
        const business = await requireBusiness(pool, subject);
        const raw = (request.body as { tagUid?: unknown } | undefined)?.tagUid;
        if (raw !== undefined && (typeof raw !== "string" || !REAL_UID.test(raw.toUpperCase()))) {
            throw new ApiError(400, "invalidTagUid", "Use the tag's 7-byte UID as 14 hex digits.");
        }
        const tagUid = typeof raw === "string" ? raw.toUpperCase() : undefined;
        return reply.code(201).send({ tagUid: await allocate(pool, business.id, "allocated", null, tagUid) });
    });

    /** The owner's phone touching a new stand from their kit while pairing is open: allocates and links one. */
    app.post("/stands/touch", async (request) => {
        const subject = await verifyBearer(auth, request.headers.authorization, "partner");
        return transaction(pool, async (client) => {
            const business = await requireBusiness(client, subject, true);
            const open = await client.query("SELECT 1 FROM businesses WHERE id = $1 AND pairing_expires_at > $2", [business.id, new Date()]);
            if (open.rowCount !== 1) throw new ApiError(409, "pairingClosed", "Start linking a stand first.");
            await allocate(client, business.id, "active", await nextStandLabel(client, business.id));
            await client.query("UPDATE businesses SET pairing_expires_at = NULL WHERE id = $1", [business.id]);
            return standsJSON(client, business.id);
        });
    });

    /**
     * A tap link with a counter newer than any this stand has sent, like the demo's "Add a stamp".
     * The counter is a timestamp so links made one after another keep going up. Nothing is stored:
     * the counter is only used when the link is opened.
     */
    /** A tap link for a place's first working stand, so any place can be tested by its ID. */
    app.post<{ Params: { businessId: string } }>("/places/:businessId/tap", async (request) => {
        const found = await pool.query<{ tag_uid: string; last_counter: string }>(
            `SELECT tag_uid, last_counter FROM readers
             WHERE kind = 'stand' AND status = 'active' AND business_id::text = $1 ORDER BY created_at LIMIT 1`,
            [request.params.businessId],
        );
        const row = found.rows[0];
        if (!row) throw standNotFound();
        const counter = Math.max(Number(row.last_counter) + 1, Date.now());
        return { next: `/t?picc=${encodeURIComponent(`${row.tag_uid}.${counter}`)}&cmac=dev` };
    });

    app.post<{ Params: { tagUid: string } }>("/taps/:tagUid", async (request) => {
        const { tagUid } = request.params;
        const found = await pool.query<{ last_counter: string }>("SELECT last_counter FROM readers WHERE kind = 'stand' AND tag_uid = $1", [tagUid]);
        const row = found.rows[0];
        if (!row) throw standNotFound();
        const counter = Math.max(Number(row.last_counter) + 1, Date.now());
        return { next: `/t?picc=${encodeURIComponent(`${tagUid}.${counter}`)}&cmac=dev` };
    });
}
