import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { transaction } from "../db.ts";
import { ApiError, invalid } from "../errors.ts";
import { parseInstant } from "../validation.ts";
import { requireBusiness, type BusinessRow } from "./partner.ts";

// Stands (docs/web-connect.md, decisions 4 and 5) and a day's activity, for the business site.
// Registered inside partnerRoutes, so every route here has already passed the owner token check and
// resolves the business from the token's subject, never from the client.
//
// A stand is allocated to a business when it's packed (or by POST /v1/dev/stands). It isn't listed
// here until it's linked: the owner opens a 2-minute pairing window, and the first tap on one of the
// business's allocated stands while it's open activates that stand instead of stamping (see
// POST /v1/web/taps). A stand allocated to another business never links, which is what stops a
// stranger claiming the stand on the counter.

export const PAIRING_SECONDS = 120;
const ACTIVITY_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const standNotFound = () => new ApiError(404, "standNotFound", "This stand isn't linked to your business.");
const noLiveProgram = () => new ApiError(409, "noLiveProgram", "Publish your card before linking a stand.");

/** readers.credential_hash is NOT NULL UNIQUE for every reader; a stand has no credential, so it hashes its tag. */
export const standCredentialHash = (tagUid: string) => createHash("sha256").update(`tag:${tagUid}`).digest("hex");

/** "Counter stand" for the first stand, then "Stand 2", "Stand 3", ... like the demo. */
export async function nextStandLabel(db: pg.PoolClient, businessId: string): Promise<string> {
    const linked = await db.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM readers WHERE business_id = $1 AND kind = 'stand' AND status <> 'allocated'",
        [businessId],
    );
    const count = linked.rows[0]!.n;
    return count === 0 ? "Counter stand" : `Stand ${count + 1}`;
}

/** `{ stands, pairing }`, the answer to every stand route. Allocated (unlinked) stands aren't listed. */
export async function standsJSON(db: pg.Pool | pg.PoolClient, businessId: string, now = new Date()) {
    const result = await db.query<{
        id: string;
        label: string | null;
        status: "active" | "disabled";
        activated_at: Date;
        last_tap_at: Date | null;
        pairing_expires_at: Date | null;
    }>(
        `SELECT r.id, r.label, r.status, r.activated_at, r.last_tap_at, b.pairing_expires_at
         FROM businesses b LEFT JOIN readers r ON r.business_id = b.id AND r.kind = 'stand' AND r.status <> 'allocated'
         WHERE b.id = $1
         ORDER BY r.activated_at, r.id`,
        [businessId],
    );
    const expires = result.rows[0]?.pairing_expires_at ?? null;
    return {
        stands: result.rows
            .filter((row) => row.id !== null)
            .map((row) => ({
                standId: row.id,
                label: row.label ?? "Stand",
                status: row.status,
                linkedAt: row.activated_at.toISOString(),
                lastTapAt: row.last_tap_at?.toISOString() ?? null,
            })),
        pairing: expires && expires > now ? { expiresAt: expires.toISOString() } : null,
    };
}

export async function standsRoutes(app: FastifyInstance, options: { pool: pg.Pool }) {
    const { pool } = options;

    app.get("/stands", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        return standsJSON(pool, business.id);
    });

    app.post("/stands/pairing", async (request) => {
        return transaction(pool, async (client) => {
            const business: BusinessRow = await requireBusiness(client, request.subject, true);
            // A stand can't stamp a card that doesn't exist yet.
            if (!business.current_version_id) throw noLiveProgram();
            const now = new Date();
            await client.query("UPDATE businesses SET pairing_expires_at = $2 WHERE id = $1", [
                business.id,
                new Date(now.getTime() + PAIRING_SECONDS * 1000),
            ]);
            return standsJSON(client, business.id, now);
        });
    });

    app.delete("/stands/pairing", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        await pool.query("UPDATE businesses SET pairing_expires_at = NULL WHERE id = $1", [business.id]);
        return standsJSON(pool, business.id);
    });

    app.post<{ Params: { standId: string } }>("/stands/:standId/turn-off", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        const { standId } = request.params;
        if (!UUID.test(standId)) throw standNotFound();
        // Turning off is for good (lost, stolen, replaced): its taps answer tagDisabled from now on.
        const updated = await pool.query(
            `UPDATE readers SET status = 'disabled', revoked_at = COALESCE(revoked_at, now())
             WHERE id = $1 AND business_id = $2 AND kind = 'stand' AND status <> 'allocated'`,
            [standId.toLowerCase(), business.id],
        );
        if (updated.rowCount !== 1) throw standNotFound();
        return standsJSON(pool, business.id);
    });

    // A day's visits for the business site's Today page. Kinds: "first" (a diner's first stamp
    // here), "stamp", "earned" (the stamp that filled a card), "used" (a reward redeemed). Never
    // names or identifies a customer: no IDs, no card IDs, nothing to link two rows to one person.
    app.get<{ Querystring: { from?: string; to?: string } }>("/activity", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        const from = request.query.from === undefined ? null : parseInstant(request.query.from, "from");
        const to = parseInstant(request.query.to, "to");
        if (from && from > to) throw invalid("invalidRange", "from must not be after to.");
        // Which stamp a punch was (its number on its card, and whether it was the diner's first
        // here) depends on earlier punches, so the window runs over everything before `to`.
        const result = await pool.query<{ kind: "first" | "stamp" | "earned" | "used"; at: Date; punches: number | null }>(
            `WITH numbered AS (
                 SELECT p.occurred_at AS at,
                        ROW_NUMBER() OVER (PARTITION BY p.card_id ORDER BY p.occurred_at, p.id)::int AS on_card,
                        ROW_NUMBER() OVER (PARTITION BY c.customer_id ORDER BY p.occurred_at, p.id) AS overall,
                        v.required_punches
                 FROM punches p
                 JOIN cards c ON c.id = p.card_id AND c.business_id = p.business_id
                 JOIN program_versions v ON v.id = c.program_version_id
                 WHERE p.business_id = $1 AND p.occurred_at < $3
             )
             SELECT CASE WHEN overall = 1 THEN 'first' WHEN on_card >= required_punches THEN 'earned' ELSE 'stamp' END AS kind,
                    at, on_card AS punches
             FROM numbered WHERE $2::timestamptz IS NULL OR at >= $2
             UNION ALL
             SELECT 'used', redeemed_at, NULL FROM rewards
             WHERE business_id = $1 AND redeemed_at < $3 AND ($2::timestamptz IS NULL OR redeemed_at >= $2)
             ORDER BY at DESC
             LIMIT $4`,
            [business.id, from, to, ACTIVITY_LIMIT],
        );
        return { activity: result.rows.map((row) => ({ kind: row.kind, at: row.at.toISOString(), punches: row.punches })) };
    });
}
