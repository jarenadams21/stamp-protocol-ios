import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { asCustomer, asPartner, businessWithProgram, setUp, TEST_WEB_ORIGIN, type TestContext } from "./helpers.ts";

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
    test("are open to anyone: no sign-in needed, and a token makes no difference", async () => {
        const anonymous = await ctx.app.inject({ method: "GET", url: "/v1/places?query=norema" });
        assert.equal(anonymous.statusCode, 200);
        const signedIn = await search("norema");
        assert.deepEqual(anonymous.json(), signedIn.body);
        const place = await ctx.app.inject({ method: "GET", url: `/v1/places/${norema}` });
        assert.equal(place.statusCode, 200);
        assert.equal(place.json().name, "Norema Cafe");
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
        assert.equal((await search("")).status, 400);
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

describe("places list (no query)", () => {
    const list = async () => {
        const response = await ctx.app.inject({ method: "GET", url: "/v1/places" });
        assert.equal(response.statusCode, 200);
        return (response.json().places as { id: string }[]).map((place) => place.id);
    };

    test("lists only places with a published card and a linked stand, newest first", async () => {
        assert.deepEqual(await list(), []);
        const stands = [];
        for (const owner of ["owner-norema", "owner-noemi"]) {
            await asPartner(ctx, owner, "POST", "/v1/partner/stands/pairing");
            stands.push((await asPartner(ctx, owner, "POST", "/v1/dev/stands/touch")).body.stands[0].standId);
        }
        // An allocated stand that was never linked doesn't count.
        await asPartner(ctx, "owner-draft", "POST", "/v1/dev/stands");
        assert.deepEqual(await list(), [noemi, norema]);

        // Turning off a place's only stand takes it off the list; search still finds it.
        await asPartner(ctx, "owner-noemi", "POST", `/v1/partner/stands/${stands[1]}/turn-off`);
        assert.deepEqual(await list(), [norema]);
        assert.deepEqual((await search("little")).body.places.map((place: { id: string }) => place.id), [noemi]);
    });

    test("answers the same shape as search", async () => {
        const response = await ctx.app.inject({ method: "GET", url: "/v1/places" });
        const [place] = response.json().places;
        assert.equal(place.name, "Norema Cafe");
        assert.equal(place.program.requiredPunches, 10);
        assert.equal(place.program.theme.typeface, "serif");
    });
});

describe("CORS", () => {
    test("allows the website's origins with credentials, on /v1/places and /v1/web only", async () => {
        const allowed = await ctx.app.inject({ method: "GET", url: "/v1/places", headers: { origin: TEST_WEB_ORIGIN } });
        assert.equal(allowed.headers["access-control-allow-origin"], TEST_WEB_ORIGIN);
        assert.equal(allowed.headers["access-control-allow-credentials"], "true");

        const preflight = await ctx.app.inject({
            method: "OPTIONS",
            url: "/v1/web/taps",
            headers: { origin: TEST_WEB_ORIGIN, "access-control-request-method": "POST" },
        });
        assert.equal(preflight.statusCode, 204);
        assert.equal(preflight.headers["access-control-allow-origin"], TEST_WEB_ORIGIN);
        assert.match(String(preflight.headers["access-control-allow-methods"]), /POST/);

        const stranger = await ctx.app.inject({ method: "GET", url: "/v1/places", headers: { origin: "https://evil.example" } });
        assert.equal(stranger.headers["access-control-allow-origin"], undefined);

        const partner = await ctx.app.inject({ method: "GET", url: "/v1/partner/business", headers: { origin: TEST_WEB_ORIGIN } });
        assert.equal(partner.headers["access-control-allow-origin"], undefined);
    });
});
