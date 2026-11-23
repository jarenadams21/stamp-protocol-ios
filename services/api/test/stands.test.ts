import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { asPartner, Browser, businessWithProgram, businessWithStand, setUp, type TestContext } from "./helpers.ts";

// The business site's stand routes, a day's activity, and the dev routes (docs/web-connect.md).

let ctx: TestContext;
before(async () => {
    ctx = await setUp();
});
after(async () => {
    await ctx?.close();
});

let counter = 100;
const next = () => ++counter;

describe("stands", () => {
    test("need an owner token and a business; pairing needs a published card", async () => {
        assert.equal((await ctx.app.inject({ method: "GET", url: "/v1/partner/stands" })).statusCode, 401);
        assert.equal((await asPartner(ctx, "owner-none", "GET", "/v1/partner/stands")).body.error, "businessNotFound");
        await asPartner(ctx, "owner-draft", "PUT", "/v1/partner/business", { name: "Draft", location: "Seattle" });
        assert.deepEqual((await asPartner(ctx, "owner-draft", "GET", "/v1/partner/stands")).body, { stands: [], pairing: null });
        const refused = await asPartner(ctx, "owner-draft", "POST", "/v1/partner/stands/pairing");
        assert.equal(refused.status, 409);
        assert.equal(refused.body.error, "noLiveProgram");
    });

    test("an owner's pairing window links the first tap on their allocated stand, instead of stamping", async () => {
        await businessWithProgram(ctx, "owner-link");
        const tagUid = (await asPartner(ctx, "owner-link", "POST", "/v1/dev/stands")).body.tagUid;
        assert.match(tagUid, /^dev-[0-9a-f]{12}$/);
        // Allocated but not linked: not listed, and a tap stamps nothing.
        assert.deepEqual((await asPartner(ctx, "owner-link", "GET", "/v1/partner/stands")).body.stands, []);
        assert.equal((await new Browser(ctx).tap(tagUid, next())).body.outcome, "tagNotActive");

        const opened = await asPartner(ctx, "owner-link", "POST", "/v1/partner/stands/pairing");
        const left = Date.parse(opened.body.pairing.expiresAt) - Date.now();
        assert.ok(left > 110_000 && left <= 120_000);
        const closed = await asPartner(ctx, "owner-link", "DELETE", "/v1/partner/stands/pairing");
        assert.equal(closed.body.pairing, null);
        assert.equal((await new Browser(ctx).tap(tagUid, next())).body.outcome, "tagNotActive");

        await asPartner(ctx, "owner-link", "POST", "/v1/partner/stands/pairing");
        const owner = new Browser(ctx);
        const linked = await owner.tap(tagUid, next());
        assert.equal(linked.body.outcome, "standLinked");
        assert.equal(linked.body.business.name, "Cafe owner-link");
        // Linking makes no customer and no punch.
        assert.equal(owner.cookie, undefined);

        const { body } = await asPartner(ctx, "owner-link", "GET", "/v1/partner/stands");
        assert.equal(body.pairing, null);
        assert.equal(body.stands.length, 1);
        const [stand] = body.stands;
        assert.equal(stand.label, "Counter stand");
        assert.equal(stand.status, "active");
        assert.ok(Date.parse(stand.linkedAt) > Date.now() - 60_000);
        assert.ok(stand.lastTapAt);
        assert.deepEqual(Object.keys(stand).sort(), ["label", "lastTapAt", "linkedAt", "standId", "status"]);

        // From now on it stamps.
        assert.equal((await new Browser(ctx).tap(tagUid, next())).body.outcome, "stamped");
    });

    test("a stand allocated to another business never links", async () => {
        await businessWithProgram(ctx, "owner-mine");
        await businessWithProgram(ctx, "owner-theirs");
        const theirs = (await asPartner(ctx, "owner-theirs", "POST", "/v1/dev/stands")).body.tagUid;
        await asPartner(ctx, "owner-mine", "POST", "/v1/partner/stands/pairing");
        assert.equal((await new Browser(ctx).tap(theirs, next())).body.outcome, "tagNotActive");
        const mine = await asPartner(ctx, "owner-mine", "GET", "/v1/partner/stands");
        assert.deepEqual(mine.body.stands, []);
        assert.ok(mine.body.pairing, "my window stays open");
        assert.deepEqual((await asPartner(ctx, "owner-theirs", "GET", "/v1/partner/stands")).body.stands, []);
    });

    test("turning a stand off is scoped to the owner's own stands", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-turn");
        await businessWithProgram(ctx, "owner-other");
        const standId = (await asPartner(ctx, "owner-turn", "GET", "/v1/partner/stands")).body.stands[0].standId;
        for (const id of [crypto.randomUUID(), "not-an-id"]) {
            assert.equal((await asPartner(ctx, "owner-turn", "POST", `/v1/partner/stands/${id}/turn-off`)).body.error, "standNotFound");
        }
        assert.equal((await asPartner(ctx, "owner-other", "POST", `/v1/partner/stands/${standId}/turn-off`)).status, 404);

        const off = await asPartner(ctx, "owner-turn", "POST", `/v1/partner/stands/${standId}/turn-off`);
        assert.equal(off.status, 200);
        assert.equal(off.body.stands[0].status, "disabled");
        assert.equal((await new Browser(ctx).tap(tagUid, next())).body.outcome, "tagDisabled");
        // Turning off twice is harmless.
        assert.equal((await asPartner(ctx, "owner-turn", "POST", `/v1/partner/stands/${standId}/turn-off`)).status, 200);
    });

    test("later stands are numbered", async () => {
        await businessWithStand(ctx, "owner-many");
        await asPartner(ctx, "owner-many", "POST", "/v1/partner/stands/pairing");
        const touched = await asPartner(ctx, "owner-many", "POST", "/v1/dev/stands/touch");
        assert.deepEqual(
            touched.body.stands.map((stand: { label: string }) => stand.label),
            ["Counter stand", "Stand 2"],
        );
        assert.equal(touched.body.pairing, null);
    });
});

describe("activity", () => {
    test("lists the day's stamps and rewards used, newest first, and never who", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-activity", 3);
        const start = new Date(Date.now() - 1000).toISOString();
        const diner = new Browser(ctx);
        for (let i = 0; i < 3; i++) await diner.tap(tagUid, next());
        await new Browser(ctx).tap(tagUid, next());
        const rewardId = (await diner.call("GET", "/v1/web/me/cards")).body.cards[0].rewardsAvailable[0].rewardId;
        await diner.call("POST", "/v1/web/redeem-intents", { rewardId });
        await diner.tap(tagUid, next());
        const end = new Date(Date.now() + 1000).toISOString();

        const { status, body } = await asPartner(ctx, "owner-activity", "GET", `/v1/partner/activity?from=${start}&to=${end}`);
        assert.equal(status, 200);
        assert.deepEqual(
            body.activity.map((item: { kind: string; punches: number | null }) => [item.kind, item.punches]),
            [
                ["used", null],
                ["first", 1],
                ["earned", 3],
                ["stamp", 2],
                ["first", 1],
            ],
        );
        for (const item of body.activity) assert.deepEqual(Object.keys(item).sort(), ["at", "kind", "punches"]);

        // Half-open range: nothing at or after `to`, and `from` is optional.
        assert.deepEqual((await asPartner(ctx, "owner-activity", "GET", `/v1/partner/activity?to=${start}`)).body.activity, []);
        assert.equal((await asPartner(ctx, "owner-activity", "GET", "/v1/partner/activity")).status, 400);
        assert.equal((await asPartner(ctx, "owner-activity", "GET", `/v1/partner/activity?from=${end}&to=${start}`)).body.error, "invalidRange");
    });
});

describe("dev routes", () => {
    test("a dev tap link always carries a newer counter", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-devtap");
        const browser = new Browser(ctx);
        const link = async () => (await ctx.app.inject({ method: "POST", url: `/v1/dev/taps/${tagUid}` })).json().next as string;
        const first = new URL(await link(), "http://x").searchParams;
        assert.equal(first.get("cmac"), "dev");
        assert.equal((await browser.call("POST", "/v1/web/taps", { picc: first.get("picc"), cmac: "dev" })).body.outcome, "stamped");
        const second = new URL(await link(), "http://x").searchParams;
        assert.equal((await browser.call("POST", "/v1/web/taps", { picc: second.get("picc"), cmac: "dev" })).body.state.card.punches, 2);
        assert.equal((await ctx.app.inject({ method: "POST", url: "/v1/dev/taps/dev-nope" })).statusCode, 404);
    });

    test("touch needs an open pairing window and an owner token", async () => {
        await businessWithProgram(ctx, "owner-touch");
        assert.equal((await asPartner(ctx, "owner-touch", "POST", "/v1/dev/stands/touch")).body.error, "pairingClosed");
        assert.equal((await ctx.app.inject({ method: "POST", url: "/v1/dev/stands" })).statusCode, 401);
    });

    test("don't exist unless AUTH_MODE=dev", async () => {
        const live = await setUp({ devRoutes: false });
        try {
            await businessWithProgram(live, "owner-live");
            assert.equal((await asPartner(live, "owner-live", "POST", "/v1/dev/stands")).status, 404);
            assert.equal((await live.app.inject({ method: "POST", url: "/v1/dev/taps/dev-anything" })).statusCode, 404);
        } finally {
            await live.close();
        }
    });
});
