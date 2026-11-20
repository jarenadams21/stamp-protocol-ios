import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SignJWT, generateKeyPair } from "jose";
import { DEV_AUDIENCES, DEV_ISSUER } from "../src/auth.ts";
import {
    asPartner,
    businessWithProgram,
    insertCard,
    insertCustomer,
    insertPunch,
    insertReader,
    insertReward,
    setUp,
    validTheme,
    type TestContext,
} from "./helpers.ts";

let ctx: TestContext;
before(async () => {
    ctx = await setUp();
});
after(async () => {
    await ctx?.close();
});

describe("auth", () => {
    const get = (authorization?: string) =>
        ctx.app.inject({ method: "GET", url: "/v1/partner/business", headers: authorization ? { authorization } : {} });

    test("rejects missing, malformed, expired, wrong-audience, and foreign-key tokens with 401", async () => {
        assert.equal((await get()).statusCode, 401);
        assert.equal((await get("Bearer not-a-jwt")).statusCode, 401);
        assert.equal((await get(`Basic abc`)).statusCode, 401);

        const expired = await ctx.signer.sign("partner", "owner-auth", "-1h");
        assert.equal((await get(`Bearer ${expired}`)).statusCode, 401);

        const customer = await ctx.signer.sign("customer", "owner-auth");
        assert.equal((await get(`Bearer ${customer}`)).statusCode, 401);

        const stranger = await generateKeyPair("RS256");
        const forged = await new SignJWT({})
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer(DEV_ISSUER)
            .setAudience(DEV_AUDIENCES.partner)
            .setSubject("owner-auth")
            .setExpirationTime("1h")
            .sign(stranger.privateKey);
        const response = await get(`Bearer ${forged}`);
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), { error: "unauthorized", message: "Sign in again." });
    });

    test("health check needs no token and reaches the database", async () => {
        const response = await ctx.app.inject({ method: "GET", url: "/healthz" });
        assert.equal(response.statusCode, 200);
        assert.ok(response.headers["x-request-id"]);
    });
});

describe("business profile", () => {
    test("is 404 before setup, created by PUT, then updated in place", async () => {
        assert.equal((await asPartner(ctx, "owner-a", "GET", "/v1/partner/business")).status, 404);

        const created = await asPartner(ctx, "owner-a", "PUT", "/v1/partner/business", {
            name: "  Norema Cafe ",
            location: "Capitol Hill, Seattle",
            timeZone: "America/Los_Angeles",
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.name, "Norema Cafe");
        assert.equal(created.body.clientId, created.body.id);
        assert.equal(created.body.currentProgramVersionId, null);

        const updated = await asPartner(ctx, "owner-a", "PUT", "/v1/partner/business", { name: "Norema" });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.id, created.body.id);
        assert.equal(updated.body.location, "");

        const fetched = await asPartner(ctx, "owner-a", "GET", "/v1/partner/business");
        assert.deepEqual(fetched.body, updated.body);
    });

    test("ignores a client-sent business ID and scopes every owner to their own business", async () => {
        const a = await asPartner(ctx, "owner-b1", "PUT", "/v1/partner/business", { name: "B1" });
        const b = await asPartner(ctx, "owner-b2", "PUT", "/v1/partner/business", { name: "B2", id: a.body.id, businessId: a.body.id });
        assert.notEqual(b.body.id, a.body.id);
        assert.equal((await asPartner(ctx, "owner-b1", "GET", "/v1/partner/business")).body.name, "B1");
    });

    test("validates input", async () => {
        const tooLong = await asPartner(ctx, "owner-c", "PUT", "/v1/partner/business", { name: "x".repeat(41) });
        assert.deepEqual(tooLong, {
            status: 400,
            body: { error: "nameTooLong", message: "Use 40 characters or fewer for the business name." },
        });
        const notJSON = await ctx.app.inject({
            method: "PUT",
            url: "/v1/partner/business",
            headers: { authorization: `Bearer ${await ctx.signer.sign("partner", "owner-c")}`, "content-type": "application/json" },
            payload: "{",
        });
        assert.equal(notJSON.statusCode, 400);
        assert.equal(notJSON.json().error, "invalidBody");
    });
});

describe("card program", () => {
    test("publishing needs a business", async () => {
        const response = await asPartner(ctx, "owner-none", "POST", "/v1/partner/program/versions", {
            requiredPunches: 10,
            rewardDescription: "One drink",
            theme: validTheme,
        });
        assert.equal(response.status, 404);
        assert.equal(response.body.error, "businessNotFound");
    });

    test("publishes immutable versions, rejects unchanged settings, and moves the live pointer", async () => {
        await asPartner(ctx, "owner-p", "PUT", "/v1/partner/business", { name: "Publisher" });
        assert.equal((await asPartner(ctx, "owner-p", "GET", "/v1/partner/program")).body.error, "programNotFound");

        const draft = { requiredPunches: 10, rewardDescription: "One handcrafted drink", theme: validTheme };
        const v1 = await asPartner(ctx, "owner-p", "POST", "/v1/partner/program/versions", draft);
        assert.equal(v1.status, 201);
        assert.equal(v1.body.version, 1);
        assert.deepEqual(v1.body.theme, { ...validTheme, coverKey: null, coverURL: null });

        const same = await asPartner(ctx, "owner-p", "POST", "/v1/partner/program/versions", {
            ...draft,
            rewardDescription: "  One handcrafted drink ",
            theme: { ...validTheme, lightPaper: "#f7efd9" },
        });
        assert.equal(same.status, 409);
        assert.equal(same.body.error, "unchangedProgram");

        const badTheme = await asPartner(ctx, "owner-p", "POST", "/v1/partner/program/versions", {
            ...draft,
            theme: { ...validTheme, lightInk: "#EFEFEF" },
        });
        assert.equal(badTheme.status, 400);
        assert.equal(badTheme.body.error, "invalidTheme");

        const v2 = await asPartner(ctx, "owner-p", "POST", "/v1/partner/program/versions", { ...draft, requiredPunches: 8 });
        assert.equal(v2.body.version, 2);
        const live = await asPartner(ctx, "owner-p", "GET", "/v1/partner/program");
        assert.equal(live.body.versionId, v2.body.versionId);
        const business = await asPartner(ctx, "owner-p", "GET", "/v1/partner/business");
        assert.equal(business.body.currentProgramVersionId, v2.body.versionId);

        await assert.rejects(
            ctx.pool.query("UPDATE program_versions SET required_punches = 5 WHERE id = $1", [v1.body.versionId]),
            /immutable/,
        );
    });

    test("version usage and publish impact follow the spec's rollover rules", async () => {
        const { businessId, versionId: v1 } = await businessWithProgram(ctx, "owner-u", 10);
        const [alice, bob, cara] = await Promise.all(["u-alice", "u-bob", "u-cara"].map((s) => insertCustomer(ctx.pool, s)));
        // Alice: card A has 4 punches. Bob: a fresh card. Cara: a completed card.
        const cardA = await insertCard(ctx.pool, { businessId, customerId: alice!, versionId: v1, punches: 4 });
        const cardB = await insertCard(ctx.pool, { businessId, customerId: bob!, versionId: v1, punches: 0 });
        await insertCard(ctx.pool, {
            businessId,
            customerId: cara!,
            versionId: v1,
            punches: 10,
            status: "completed",
            completedAt: "2026-11-01T00:00:00Z",
        });

        const impact = await asPartner(ctx, "owner-u", "GET", "/v1/partner/program/publish-impact");
        assert.deepEqual(impact.body, { keepRules: 1, switchToNew: 1 });

        const v2 = await asPartner(ctx, "owner-u", "POST", "/v1/partner/program/versions", {
            requiredPunches: 8,
            rewardDescription: "One drink",
            theme: validTheme,
        });

        const cards = await ctx.pool.query<{ id: string; program_version_id: string }>(
            "SELECT id, program_version_id FROM cards WHERE id = ANY($1)",
            [[cardA, cardB]],
        );
        const versionOf = Object.fromEntries(cards.rows.map((row) => [row.id, row.program_version_id]));
        assert.equal(versionOf[cardA], v1, "a card with punches keeps its version");
        assert.equal(versionOf[cardB], v2.body.versionId, "a card with no punches moves to the live version");

        const versions = await asPartner(ctx, "owner-u", "GET", "/v1/partner/program/versions");
        assert.deepEqual(
            versions.body.versions.map((v: { version: number; usage: unknown }) => [v.version, v.usage]),
            [
                [2, { status: "live", inProgress: 1, completed: 0 }],
                [1, { status: "finishing", inProgress: 1, completed: 1 }],
            ],
        );
    });

    test("the database keeps a card's punches within its version", async () => {
        const { businessId, versionId } = await businessWithProgram(ctx, "owner-db", 5);
        const customer = await insertCustomer(ctx.pool, "db-dana");
        await assert.rejects(insertCard(ctx.pool, { businessId, customerId: customer, versionId, punches: 6, status: "completed", completedAt: "2026-11-01T00:00:00Z" }));
        await assert.rejects(insertCard(ctx.pool, { businessId, customerId: customer, versionId, punches: 5 }), /active with 5 of 5/);
        await insertCard(ctx.pool, { businessId, customerId: customer, versionId, punches: 4 });
        await assert.rejects(insertCard(ctx.pool, { businessId, customerId: customer, versionId, punches: 0 }), /cards_one_active_per_customer/);
    });
});

describe("dashboard", () => {
    test("counts match section 8.4: unique enrollment, half-open ranges, all-time waiting rewards", async () => {
        const { businessId, versionId } = await businessWithProgram(ctx, "owner-d", 3);
        const reader = await insertReader(ctx.pool, businessId);
        const erin = await insertCustomer(ctx.pool, "d-erin");
        const finn = await insertCustomer(ctx.pool, "d-finn");

        // Erin filled two cards (rewards stack) and is on her third. Finn filled one and redeemed it.
        const done = { status: "completed", punches: 3 };
        const e1 = await insertCard(ctx.pool, { businessId, customerId: erin, versionId, ...done, completedAt: "2026-11-02T10:00:00Z" });
        const e2 = await insertCard(ctx.pool, { businessId, customerId: erin, versionId, ...done, completedAt: "2026-11-05T10:00:00Z" });
        await insertCard(ctx.pool, { businessId, customerId: erin, versionId, punches: 1 });
        const f1 = await insertCard(ctx.pool, { businessId, customerId: finn, versionId, ...done, completedAt: "2026-11-03T10:00:00Z" });

        for (const occurredAt of ["2026-11-01T00:00:00Z", "2026-11-04T23:59:59Z", "2026-11-05T00:00:00Z", "2026-11-06T12:00:00Z"]) {
            await insertPunch(ctx.pool, { businessId, cardId: e1, readerId: reader, occurredAt });
        }
        await insertReward(ctx.pool, { businessId, cardId: e1, customerId: erin, earnedAt: "2026-11-02T10:00:00Z" });
        await insertReward(ctx.pool, { businessId, cardId: e2, customerId: erin, earnedAt: "2026-11-05T10:00:00Z" });
        await insertReward(ctx.pool, {
            businessId,
            cardId: f1,
            customerId: finn,
            earnedAt: "2026-11-03T10:00:00Z",
            redeemedAt: "2026-11-04T09:00:00Z",
        });

        const range = await asPartner(ctx, "owner-d", "GET", "/v1/partner/dashboard?from=2026-11-01T00:00:00Z&to=2026-11-05T00:00:00Z");
        assert.deepEqual(range.body, {
            enrolledCardholders: 2,
            punches: 2, // the punch at exactly `to` is excluded
            rewardsEarned: 2,
            rewardsRedeemed: 1,
            rewardsWaiting: 2,
            customersWithStackedRewards: 1,
        });

        const allTime = await asPartner(ctx, "owner-d", "GET", "/v1/partner/dashboard?to=2026-12-01T00:00:00-08:00");
        assert.equal(allTime.body.punches, 4);
        assert.equal(allTime.body.rewardsEarned, 3);

        assert.equal((await asPartner(ctx, "owner-d", "GET", "/v1/partner/dashboard")).body.error, "invalidRange");
        assert.equal((await asPartner(ctx, "owner-d", "GET", "/v1/partner/dashboard?to=2026-11-05")).body.error, "invalidRange");
        const backwards = await asPartner(ctx, "owner-d", "GET", "/v1/partner/dashboard?from=2026-11-05T00:00:00Z&to=2026-11-01T00:00:00Z");
        assert.equal(backwards.status, 400);

        // Another owner sees none of this business's activity.
        await businessWithProgram(ctx, "owner-d2");
        const other = await asPartner(ctx, "owner-d2", "GET", "/v1/partner/dashboard?to=2026-12-01T00:00:00Z");
        assert.equal(other.body.enrolledCardholders, 0);
        assert.equal(other.body.rewardsWaiting, 0);
    });
});

describe("notifications", () => {
    test("pages newest first with an exact cursor", async () => {
        const { businessId } = await businessWithProgram(ctx, "owner-n");
        await ctx.pool.query(
            `INSERT INTO notifications (business_id, kind, payload, created_at)
             SELECT $1, CASE WHEN i % 2 = 0 THEN 'reward.waiting' ELSE 'card.rolledOver' END,
                    jsonb_build_object('n', i), timestamptz '2026-11-09 18:00:00.000001+00' + i * interval '1 microsecond'
             FROM generate_series(1, 5) AS i`,
            [businessId],
        );
        const seen: number[] = [];
        let cursor: string | null = null;
        do {
            const page: { body: { notifications: { payload: { n: number } }[]; nextCursor: string | null } } = await asPartner(
                ctx,
                "owner-n",
                "GET",
                `/v1/partner/notifications?limit=2${cursor ? `&after=${cursor}` : ""}`,
            );
            seen.push(...page.body.notifications.map((n) => n.payload.n));
            cursor = page.body.nextCursor;
        } while (cursor);
        assert.deepEqual(seen, [5, 4, 3, 2, 1]);

        assert.equal((await asPartner(ctx, "owner-n", "GET", "/v1/partner/notifications?after=garbage")).status, 400);
        const other = await asPartner(ctx, "owner-n2", "PUT", "/v1/partner/business", { name: "Other" });
        assert.equal(other.status, 201);
        assert.deepEqual((await asPartner(ctx, "owner-n2", "GET", "/v1/partner/notifications")).body.notifications, []);
    });
});
