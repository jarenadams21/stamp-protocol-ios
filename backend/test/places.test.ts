import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { asCustomer, asPartner, businessWithProgram, setUp, type TestContext } from "./helpers.ts";

let ctx: TestContext;
let norema: string;
let noemi: string;
before(async () => {
    ctx = await setUp();
    // Names are "Cafe <subject>" from businessWithProgram; rename for realistic searches.
    norema = (await businessWithProgram(ctx, "owner-norema", 10)).businessId;
    await asPartner(ctx, "owner-norema", "PUT", "/v1/partner/business", { name: "Norema Cafe", location: "Capitol Hill, Seattle" });
    noemi = (await businessWithProgram(ctx, "owner-noemi", 6)).businessId;
    await asPartner(ctx, "owner-noemi", "PUT", "/v1/partner/business", { name: "Little Norema 100%", location: "Fremont" });
    // Set up but never published: not a place yet.
    await asPartner(ctx, "owner-draft", "PUT", "/v1/partner/business", { name: "Norema Draft", location: "Seattle" });
});
after(async () => {
    await ctx?.close();
});

const search = (query: string) => asCustomer(ctx, "diner-1", `/v1/places?query=${encodeURIComponent(query)}`);

describe("places", () => {
    test("need a customer token", async () => {
        const anonymous = await ctx.app.inject({ method: "GET", url: "/v1/places?query=norema" });
        assert.equal(anonymous.statusCode, 401);
        const partner = await asPartner(ctx, "owner-norema", "GET", "/v1/places?query=norema");
        assert.equal(partner.status, 401);
    });

    test("search finds names case-insensitively, prefixes first, and skips unpublished businesses", async () => {
        const { status, body } = await search("  noREMA ");
        assert.equal(status, 200);
        assert.deepEqual(
            body.places.map((place: { name: string }) => place.name),
            ["Norema Cafe", "Little Norema 100%"],
        );
        const [first] = body.places;
        assert.equal(first.id, norema);
        assert.equal(first.clientId, norema);
        assert.equal(first.location, "Capitol Hill, Seattle");
        assert.equal(first.program.requiredPunches, 10);
        assert.equal(first.program.rewardDescription, "One drink");
        assert.equal(first.program.theme.typeface, "serif");
    });

    test("search by exact client ID, in any case", async () => {
        const { body } = await search(noemi.toUpperCase());
        assert.deepEqual(body.places.map((place: { id: string }) => place.id), [noemi]);
    });

    test("wildcards are text, not patterns", async () => {
        assert.deepEqual((await search("100%")).body.places.map((place: { id: string }) => place.id), [noemi]);
        assert.deepEqual((await search("%")).body.places.map((place: { id: string }) => place.id), [noemi]);
        assert.deepEqual((await search("_")).body.places, []);
    });

    test("an empty or overlong query is refused", async () => {
        assert.equal((await search("   ")).body.error, "invalidQuery");
        assert.equal((await asCustomer(ctx, "diner-1", "/v1/places")).status, 400);
        assert.equal((await search("x".repeat(41))).status, 400);
    });

    test("a place reads with its live card; unknown, malformed, and unpublished IDs are all 404", async () => {
        const { status, body } = await asCustomer(ctx, "diner-1", `/v1/places/${norema}`);
        assert.equal(status, 200);
        assert.equal(body.name, "Norema Cafe");
        assert.equal(body.program.version, 1);
        assert.equal(body.program.theme.coverURL, null);

        const draft = await asPartner(ctx, "owner-draft", "GET", "/v1/partner/business");
        for (const id of [crypto.randomUUID(), "not-an-id", draft.body.id]) {
            const missing = await asCustomer(ctx, "diner-1", `/v1/places/${id}`);
            assert.equal(missing.status, 404);
            assert.equal(missing.body.error, "placeNotFound");
        }
    });
});
