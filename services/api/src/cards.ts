import type pg from "pg";

// The card lifecycle (docs/backend-spec.md section 4), written once for every way a punch arrives:
// a stand tap on the website now, a reader's POST /v1/punches later, and the punches an anonymous
// browser brings along when it signs in. Callers run it inside their transaction and lock the
// customer row first, so two punches for one customer never race to open or roll over a card.

export interface CardRow {
    id: string;
    business_id: string;
    program_version_id: string;
    punches: number;
    status: "active" | "completed" | "closed";
    required_punches: number;
}

export interface PunchOutcome {
    card: CardRow;
    /** This punch rolled a full card over into a new one (section 4, step 4). */
    startedNewCard: boolean;
    /** Set when this punch filled the card: the one reward it earned. */
    rewardId?: string;
}

/** The punch to record: a new one, or one already recorded on another card (a sign-in merge). */
export type PunchSource =
    | { insert: { readerId: string; eventId: string; occurredAt: Date } }
    | { move: { punchId: string; occurredAt: Date } };

/** The customer's newest card at the business: the open one, or the full one waiting for its next punch. */
export async function newestCard(client: pg.PoolClient, customerId: string, businessId: string, lock = false): Promise<CardRow | undefined> {
    const result = await client.query<CardRow>(
        `SELECT c.id, c.business_id, c.program_version_id, c.punches, c.status, v.required_punches
         FROM cards c JOIN program_versions v ON v.id = c.program_version_id
         WHERE c.customer_id = $1 AND c.business_id = $2
         ORDER BY (c.status = 'active') DESC, c.created_at DESC, c.id DESC
         LIMIT 1${lock ? " FOR UPDATE OF c" : ""}`,
        [customerId, businessId],
    );
    return result.rows[0];
}

/** A partner notification (section 7). Never names the customer. */
export async function notify(client: pg.PoolClient, businessId: string, kind: "card.rolledOver" | "reward.waiting", payload: object = {}) {
    await client.query("INSERT INTO notifications (business_id, kind, payload) VALUES ($1, $2, $3)", [businessId, kind, payload]);
}

/** reward.waiting carries the business's new all-time count of unredeemed rewards. */
export async function notifyRewardsWaiting(client: pg.PoolClient, businessId: string) {
    const waiting = await client.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM rewards WHERE business_id = $1 AND redeemed_at IS NULL",
        [businessId],
    );
    await notify(client, businessId, "reward.waiting", { rewardsWaiting: waiting.rows[0]!.n });
}

/**
 * Adds one punch to the customer's card at the business: enrolls on the live version if they have
 * no card, rolls a full card over into a new one with this punch as its first, and earns exactly one
 * reward when the card fills. Returns undefined when the business has no live card to enroll on.
 */
export async function addPunch(client: pg.PoolClient, customerId: string, businessId: string, source: PunchSource): Promise<PunchOutcome | undefined> {
    let card = await newestCard(client, customerId, businessId, true);
    let startedNewCard = false;
    if (!card || card.status !== "active") {
        const live = await client.query<{ id: string; required_punches: number }>(
            `SELECT v.id, v.required_punches FROM businesses b JOIN program_versions v ON v.id = b.current_version_id
             WHERE b.id = $1`,
            [businessId],
        );
        const version = live.rows[0];
        if (!version) return undefined;
        const inserted = await client.query<{ id: string }>(
            `INSERT INTO cards (business_id, customer_id, program_version_id) VALUES ($1, $2, $3) RETURNING id`,
            [businessId, customerId, version.id],
        );
        startedNewCard = card !== undefined;
        card = {
            id: inserted.rows[0]!.id,
            business_id: businessId,
            program_version_id: version.id,
            punches: 0,
            status: "active",
            required_punches: version.required_punches,
        };
        if (startedNewCard) await notify(client, businessId, "card.rolledOver");
    }

    if ("insert" in source) {
        const { readerId, eventId, occurredAt } = source.insert;
        await client.query(
            `INSERT INTO punches (business_id, card_id, reader_id, event_id, occurred_at) VALUES ($1, $2, $3, $4, $5)`,
            [businessId, card.id, readerId, eventId, occurredAt],
        );
    } else {
        await client.query("UPDATE punches SET card_id = $1 WHERE id = $2", [card.id, source.move.punchId]);
    }

    const punches = card.punches + 1;
    const full = punches >= card.required_punches;
    const occurredAt = "insert" in source ? source.insert.occurredAt : source.move.occurredAt;
    // completed_at is when the card filled; for a merged punch that is now, not when it was tapped.
    const completedAt = full ? ("insert" in source ? occurredAt : new Date()) : null;
    await client.query(
        `UPDATE cards SET punches = $2, status = $3, completed_at = $4 WHERE id = $1`,
        [card.id, punches, full ? "completed" : "active", completedAt],
    );
    card = { ...card, punches, status: full ? "completed" : "active" };

    let rewardId: string | undefined;
    if (full) {
        const reward = await client.query<{ id: string }>(
            `INSERT INTO rewards (business_id, card_id, customer_id, earned_at) VALUES ($1, $2, $3, $4) RETURNING id`,
            [businessId, card.id, customerId, completedAt],
        );
        rewardId = reward.rows[0]!.id;
        await notifyRewardsWaiting(client, businessId);
    }
    return { card, startedNewCard, rewardId };
}
