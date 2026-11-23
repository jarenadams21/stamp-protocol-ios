import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { phoneHash } from "../src/signIn.ts";
import { tagVerifier } from "../src/tags.ts";
import { asPartner, Browser, businessWithStand, setUp, TEST_PEPPER, validTheme, type TestContext } from "./helpers.ts";

// The website's diner routes, /v1/web/* (apps/web/docs/identity-and-api.md).

let ctx: TestContext;
before(async () => {
    ctx = await setUp();
});
after(async () => {
    await ctx?.close();
});

/** Each stand's counters must go up; tests take the next one from here. */
let counter = 100;
const next = () => ++counter;

const customerOf = async (cookie: string | undefined) => {
    const result = await ctx.pool.query<{ id: string; subject: string }>(
        `SELECT c.id, c.subject FROM web_sessions s JOIN customers c ON c.id = s.customer_id
         WHERE s.token_hash = sha256(convert_to($1, 'UTF8'))`,
        [cookie ?? ""],
    );
    return result.rows[0];
};

describe("taps", () => {
    test("a first tap with no cookie stamps an anonymous card and sets the session cookie", async () => {
        const { tagUid, businessId } = await businessWithStand(ctx, "owner-tap1", 5);
        const browser = new Browser(ctx);
        const tapped = await browser.tap(tagUid, next());
        assert.equal(tapped.status, 200);
        assert.equal(tapped.body.outcome, "stamped");
        assert.equal(tapped.body.startedNewCard, false);
        assert.deepEqual(tapped.body.identity, { kind: "anonymous" });
        assert.equal(tapped.body.state.business.id, businessId);
        assert.equal(tapped.body.state.business.name, "Cafe owner-tap1");
        assert.deepEqual(tapped.body.state.card.punches, 1);
        assert.equal(tapped.body.state.card.requiredPunches, 5);
        assert.equal(tapped.body.state.program.theme.typeface, "serif");
        assert.equal(tapped.body.state.recentVisits.length, 1);

        assert.match(browser.lastSetCookie!, /^joeyy_web=[A-Za-z0-9_-]{43}; Path=\/v1\/web; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure$/);
        const customer = await customerOf(browser.cookie);
        assert.match(customer!.subject, /^web:[0-9a-f-]{36}$/);

        // The punch is an ordinary punch: the stand is its reader, the event ID names the tag and counter.
        const punch = await ctx.pool.query<{ event_id: string; kind: string }>(
            `SELECT p.event_id, r.kind FROM punches p JOIN readers r ON r.id = p.reader_id WHERE r.tag_uid = $1`,
            [tagUid],
        );
        assert.deepEqual(punch.rows, [{ event_id: `tag:${tagUid}:${counter}`, kind: "stand" }]);

        // The same browser keeps the same card.
        const again = await browser.tap(tagUid, next());
        assert.equal(again.body.state.card.punches, 2);
        assert.equal(browser.lastSetCookie, undefined);
    });

    test("a reused or older counter is replayed and adds nothing", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-replay");
        const browser = new Browser(ctx);
        const first = next();
        await browser.tap(tagUid, first);
        const reused = await browser.tap(tagUid, first);
        assert.equal(reused.body.outcome, "replayed");
        assert.equal(reused.body.state.card.punches, 1);
        const older = await browser.tap(tagUid, first - 1);
        assert.equal(older.body.outcome, "replayed");
        // A replay on a browser with no card here says only that.
        const stranger = await new Browser(ctx).tap(tagUid, first);
        assert.deepEqual(stranger.body, { outcome: "replayed" });
        assert.equal((await browser.tap(tagUid, next())).body.state.card.punches, 2);
    });

    test("unknown tags, malformed links, and a missing signature are invalidTag", async () => {
        const browser = new Browser(ctx);
        assert.deepEqual((await browser.tap("dev-unknown", next())).body, { outcome: "invalidTag" });
        for (const body of [{ picc: "nope", cmac: "dev" }, { picc: "dev-x.1", cmac: "" }, { picc: 12, cmac: "dev" }, {}]) {
            const response = await browser.call("POST", "/v1/web/taps", body);
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, { outcome: "invalidTag" });
        }
        // Nothing was created for these taps.
        assert.equal(browser.cookie, undefined);
    });

    test("filling a card earns one reward; the next tap rolls over, and rewards stack", async () => {
        const { tagUid, businessId } = await businessWithStand(ctx, "owner-fill", 3);
        const browser = new Browser(ctx);
        await browser.tap(tagUid, next());
        await browser.tap(tagUid, next());
        const full = await browser.tap(tagUid, next());
        assert.equal(full.body.outcome, "completed");
        assert.equal(full.body.state.card.status, "completed");
        assert.equal(full.body.state.card.punches, 3);
        assert.equal(full.body.reward.rewardDescription, "One drink");
        assert.deepEqual(full.body.state.rewardsAvailable.map((reward: { rewardId: string }) => reward.rewardId), [full.body.reward.rewardId]);

        const rolled = await browser.tap(tagUid, next());
        assert.equal(rolled.body.outcome, "stamped");
        assert.equal(rolled.body.startedNewCard, true);
        assert.equal(rolled.body.state.card.punches, 1);
        assert.equal(rolled.body.state.card.status, "active");
        assert.equal(rolled.body.state.rewardsAvailable.length, 1);

        await browser.tap(tagUid, next());
        const second = await browser.tap(tagUid, next());
        assert.equal(second.body.outcome, "completed");
        assert.equal(second.body.state.rewardsAvailable.length, 2);

        const kinds = await ctx.pool.query<{ kind: string; payload: { rewardsWaiting?: number } }>(
            "SELECT kind, payload FROM notifications WHERE business_id = $1 ORDER BY created_at, kind",
            [businessId],
        );
        assert.deepEqual(
            kinds.rows.map((row) => row.kind),
            ["reward.waiting", "card.rolledOver", "reward.waiting"],
        );
        assert.equal(kinds.rows[2]!.payload.rewardsWaiting, 2);
        const dashboard = await asPartner(ctx, "owner-fill", "GET", `/v1/partner/dashboard?to=${new Date(Date.now() + 60_000).toISOString()}`);
        assert.equal(dashboard.body.punches, 6);
        assert.equal(dashboard.body.rewardsWaiting, 2);
        assert.equal(dashboard.body.customersWithStackedRewards, 1);
    });

    test("an allocated stand stamps nothing (tagNotActive), but still uses up its counter", async () => {
        await businessWithStand(ctx, "owner-alloc");
        const tagUid = (await asPartner(ctx, "owner-alloc", "POST", "/v1/dev/stands")).body.tagUid;
        const browser = new Browser(ctx);
        const tapped = await browser.tap(tagUid, 5);
        assert.equal(tapped.body.outcome, "tagNotActive");
        assert.equal(tapped.body.business.name, "Cafe owner-alloc");
        assert.equal(browser.cookie, undefined);
        assert.equal((await browser.tap(tagUid, 5)).body.outcome, "replayed");
    });

    test("a turned-off stand answers tagDisabled", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-off");
        const stands = await asPartner(ctx, "owner-off", "GET", "/v1/partner/stands");
        await asPartner(ctx, "owner-off", "POST", `/v1/partner/stands/${stands.body.stands[0].standId}/turn-off`);
        const tapped = await new Browser(ctx).tap(tagUid, next());
        assert.equal(tapped.body.outcome, "tagDisabled");
        assert.equal(tapped.body.business.name, "Cafe owner-off");
    });

    test("an open redeem window turns the next tap into a single-use redemption", async () => {
        const { tagUid, businessId } = await businessWithStand(ctx, "owner-redeem", 3);
        const browser = new Browser(ctx);
        for (let i = 0; i < 3; i++) await browser.tap(tagUid, next());
        const cards = await browser.call("GET", "/v1/web/me/cards");
        const rewardId = cards.body.cards[0].rewardsAvailable[0].rewardId;

        // Only the diner who holds the reward can open a window for it.
        assert.equal((await new Browser(ctx).call("POST", "/v1/web/redeem-intents", { rewardId })).status, 404);

        const opened = await browser.call("POST", "/v1/web/redeem-intents", { rewardId });
        assert.equal(opened.status, 200);
        assert.equal(opened.body.rewardId, rewardId);
        assert.equal(opened.body.businessId, businessId);
        const left = Date.parse(opened.body.expiresAt) - Date.now();
        assert.ok(left > 110_000 && left <= 120_000);
        const waiting = await browser.call("GET", `/v1/web/redeem-intents/${opened.body.intentId}`);
        assert.deepEqual(waiting.body, { intent: opened.body });
        assert.equal((await new Browser(ctx).call("GET", `/v1/web/redeem-intents/${opened.body.intentId}`)).status, 404);

        const redeemed = await browser.tap(tagUid, next());
        assert.equal(redeemed.body.outcome, "redeemed");
        assert.equal(redeemed.body.redemption.rewardId, rewardId);
        assert.equal(redeemed.body.redemption.rewardDescription, "One drink");
        assert.equal(redeemed.body.redemption.intentId, opened.body.intentId);
        assert.match(redeemed.body.redemption.code, /^[0-9A-F]{4}$/);
        assert.deepEqual(redeemed.body.state.rewardsAvailable, []);
        // Redeeming never changes punches.
        assert.equal(redeemed.body.state.card.punches, 3);

        const read = await browser.call("GET", `/v1/web/redeem-intents/${opened.body.intentId}`);
        assert.deepEqual(read.body.redemption, redeemed.body.redemption);

        // Used once: the next tap stamps (rolling over the full card).
        const after = await browser.tap(tagUid, next());
        assert.equal(after.body.outcome, "stamped");
        assert.equal(after.body.startedNewCard, true);
        assert.equal((await browser.call("POST", "/v1/web/redeem-intents", { rewardId })).status, 404);
    });

    test("an expired or cancelled window doesn't redeem", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-expire", 3);
        const browser = new Browser(ctx);
        for (let i = 0; i < 3; i++) await browser.tap(tagUid, next());
        const rewardId = (await browser.call("GET", "/v1/web/me/cards")).body.cards[0].rewardsAvailable[0].rewardId;

        const cancelled = await browser.call("POST", "/v1/web/redeem-intents", { rewardId });
        assert.equal((await browser.call("DELETE", `/v1/web/redeem-intents/${cancelled.body.intentId}`)).status, 204);
        assert.equal((await browser.call("GET", `/v1/web/redeem-intents/${cancelled.body.intentId}`)).status, 404);
        assert.equal((await browser.tap(tagUid, next())).body.outcome, "stamped");

        const opened = await browser.call("POST", "/v1/web/redeem-intents", { rewardId });
        await ctx.pool.query("UPDATE redeem_intents SET created_at = now() - interval '3 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [
            opened.body.intentId,
        ]);
        const tapped = await browser.tap(tagUid, next());
        assert.equal(tapped.body.outcome, "stamped");
        assert.equal(tapped.body.state.rewardsAvailable.length, 1);
    });

    test("a business's own minimum gap between stamps answers cooldown", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-gap", 5);
        const published = await asPartner(ctx, "owner-gap", "POST", "/v1/partner/program/versions", {
            requiredPunches: 5,
            rewardDescription: "One drink",
            theme: validTheme,
            minMinutesBetweenStamps: 30,
        });
        assert.equal(published.status, 201);
        assert.equal(published.body.minMinutesBetweenStamps, 30);
        const browser = new Browser(ctx);
        const first = await browser.tap(tagUid, next());
        assert.equal(first.body.state.program.minMinutesBetweenStamps, 30);
        const soon = await browser.tap(tagUid, next());
        assert.equal(soon.body.outcome, "cooldown");
        assert.equal(soon.body.state.card.punches, 1);
        const wait = Date.parse(soon.body.nextStampAt) - Date.now();
        assert.ok(wait > 29 * 60_000 && wait <= 30 * 60_000);
    });

    test("TAG_MODE=sun verifies NTAG 424 DNA SUN messages and refuses dev links", async () => {
        const sun = await setUp({ tags: tagVerifier("sun", { metaRead: Buffer.alloc(16), fileRead: Buffer.alloc(16) }) });
        try {
            await asPartner(sun, "owner-sun", "PUT", "/v1/partner/business", { name: "Sun Cafe", location: "Seattle" });
            await asPartner(sun, "owner-sun", "POST", "/v1/partner/program/versions", { requiredPunches: 5, rewardDescription: "Tea", theme: validTheme });
            const business = await asPartner(sun, "owner-sun", "GET", "/v1/partner/business");
            // AN12196's example tag: UID 04DE5F1EACC040, read counter 61, all-zero keys.
            await sun.pool.query(
                `INSERT INTO readers (business_id, kind, tag_uid, status, credential_hash, activated_at)
                 VALUES ($1, 'stand', '04DE5F1EACC040', 'active', 'sun-test', now())`,
                [business.body.id],
            );
            const browser = new Browser(sun);
            const real = { picc: "EF963FF7828658A599F3041510671E88", cmac: "94EED9EE65337086" };
            const tapped = await browser.call("POST", "/v1/web/taps", real);
            assert.equal(tapped.body.outcome, "stamped");
            assert.equal((await browser.call("POST", "/v1/web/taps", real)).body.outcome, "replayed");
            const forged = await browser.call("POST", "/v1/web/taps", { ...real, cmac: "94EED9EE65337087" });
            assert.deepEqual(forged.body, { outcome: "invalidTag" });
            assert.deepEqual((await browser.tap("04DE5F1EACC040", 99)).body, { outcome: "invalidTag" });
        } finally {
            await sun.close();
        }
    });
});

describe("cards", () => {
    test("a browser with no cookie has no cards and isn't given a session", async () => {
        const browser = new Browser(ctx);
        const response = await browser.call("GET", "/v1/web/me/cards");
        assert.deepEqual(response.body, { identity: { kind: "anonymous" }, cards: [] });
        assert.equal(browser.cookie, undefined);
        assert.equal(response.headers["cache-control"], "no-store");
    });

    test("one card per business, most recent visit first unless the diner chose an order", async () => {
        const a = await businessWithStand(ctx, "owner-order-a");
        const b = await businessWithStand(ctx, "owner-order-b");
        const browser = new Browser(ctx);
        await browser.tap(a.tagUid, next());
        await browser.tap(b.tagUid, next());
        const ids = async () => (await browser.call("GET", "/v1/web/me/cards")).body.cards.map((card: { business: { id: string } }) => card.business.id);
        assert.deepEqual(await ids(), [b.businessId, a.businessId]);

        assert.equal((await browser.call("PUT", "/v1/web/me/cards/order", { businessIds: [a.businessId, "junk", crypto.randomUUID()] })).status, 204);
        assert.deepEqual(await ids(), [a.businessId, b.businessId]);
        assert.equal((await browser.call("PUT", "/v1/web/me/cards/order", { businessIds: "nope" })).status, 400);

        const one = await browser.call("GET", `/v1/web/me/cards/${b.businessId}`);
        assert.equal(one.body.business.id, b.businessId);
        assert.equal(one.body.card.punches, 1);
        assert.equal((await browser.call("GET", `/v1/web/me/cards/${crypto.randomUUID()}`)).body.code, "notFound");
        assert.equal((await browser.call("GET", "/v1/web/me/cards/not-an-id")).status, 404);
        assert.equal((await new Browser(ctx).call("GET", `/v1/web/me/cards/${b.businessId}`)).status, 404);
    });

    test("writes from another origin are refused", async () => {
        const browser = new Browser(ctx);
        const response = await browser.call("POST", "/v1/web/sign-out", undefined, { origin: "https://evil.example" });
        assert.equal(response.status, 403);
        assert.equal(response.body.code, "forbiddenOrigin");
        assert.equal((await browser.call("POST", "/v1/web/sign-out", undefined, { origin: "https://joeyy.test" })).status, 204);
    });
});

describe("sign-in", () => {
    const NUMBER = "+12065550100";

    async function signInByPhone(browser: Browser, typed = "(206) 555-0100") {
        ctx.clockOffsetMs += 60_000; // past the resend cooldown from any earlier code
        const started = await browser.call("POST", "/v1/web/phone/start", { phone: typed });
        assert.equal(started.status, 200, JSON.stringify(started.body));
        assert.deepEqual(started.body, { maskedPhone: "••• ••• 0100" });
        return browser.call("POST", "/v1/web/phone/verify", { code: ctx.sms.lastCode(NUMBER) });
    }

    test("a number new to JOEYY upgrades this browser's customer in place, as the app's account", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-sign1", 3);
        const browser = new Browser(ctx);
        await browser.tap(tagUid, next());
        await browser.tap(tagUid, next());
        const before = await customerOf(browser.cookie);
        const result = await signInByPhone(browser);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, {
            identity: { kind: "account", method: "phone", maskedPhone: "••• ••• 0100" },
            moved: [],
            restoredCards: 0,
            restoredRewards: 0,
        });
        const afterwards = await customerOf(browser.cookie);
        assert.equal(afterwards!.id, before!.id);
        // The same subject the iOS app signs in to for this number.
        assert.equal(afterwards!.subject, `phone:${phoneHash(TEST_PEPPER, NUMBER)}`);
    });

    test("a new browser's anonymous stamps merge into the account: fills earn rewards, extras roll over", async () => {
        const { tagUid: sign1 } = await ctx.pool
            .query<{ tag_uid: string }>(
                `SELECT r.tag_uid FROM readers r JOIN businesses b ON b.id = r.business_id WHERE b.name = 'Cafe owner-sign1'`,
            )
            .then((result) => ({ tagUid: result.rows[0]!.tag_uid }));
        const other = await businessWithStand(ctx, "owner-sign2", 5);
        const browser = new Browser(ctx);
        await browser.tap(sign1, next());
        await browser.tap(sign1, next());
        await browser.tap(other.tagUid, next());
        const anonymous = await customerOf(browser.cookie);

        // The account (signed in on the first browser) has 2 of 3 at sign1; this browser brings 2 more.
        const result = await signInByPhone(browser, "2065550100");
        assert.equal(result.status, 200);
        assert.equal(result.body.identity.kind, "account");
        assert.equal(result.body.restoredCards, 1);
        assert.equal(result.body.restoredRewards, 0);
        const sign1Id = (await ctx.pool.query<{ id: string }>("SELECT id FROM businesses WHERE name = 'Cafe owner-sign1'")).rows[0]!.id;
        assert.deepEqual(
            [...result.body.moved].sort((x: { stamps: number }, y: { stamps: number }) => y.stamps - x.stamps),
            [
                { businessId: sign1Id, stamps: 2 },
                { businessId: other.businessId, stamps: 1 },
            ],
        );

        const cards = await browser.call("GET", "/v1/web/me/cards");
        const bySign1 = cards.body.cards.find((card: { business: { id: string } }) => card.business.id === sign1Id);
        // 2 + 2 = 4 of 3: one reward, and the extra stamp started the next card.
        assert.equal(bySign1.card.punches, 1);
        assert.equal(bySign1.card.status, "active");
        assert.equal(bySign1.rewardsAvailable.length, 1);
        assert.equal(bySign1.recentVisits.length, 4);
        const byOther = cards.body.cards.find((card: { business: { id: string } }) => card.business.id === other.businessId);
        assert.equal(byOther.card.punches, 1);

        // The anonymous customer is gone; both browsers now share one account.
        assert.equal((await ctx.pool.query("SELECT 1 FROM customers WHERE id = $1", [anonymous!.id])).rowCount, 0);
        const accounts = await ctx.pool.query("SELECT 1 FROM customers WHERE subject = $1", [`phone:${phoneHash(TEST_PEPPER, NUMBER)}`]);
        assert.equal(accounts.rowCount, 1);
        // Every punch is still recorded once.
        const punches = await ctx.pool.query<{ n: number }>(
            "SELECT COUNT(*)::int AS n FROM punches p JOIN cards c ON c.id = p.card_id WHERE c.business_id = $1",
            [sign1Id],
        );
        assert.equal(punches.rows[0]!.n, 4);
    });

    test("the app's own phone sign-in reaches the same account", async () => {
        ctx.clockOffsetMs += 60_000;
        await ctx.app.inject({ method: "POST", url: "/v1/auth/phone/start", payload: { phoneNumber: NUMBER } });
        const verified = await ctx.app.inject({
            method: "POST",
            url: "/v1/auth/phone/verify",
            payload: { role: "customer", phoneNumber: NUMBER, code: ctx.sms.lastCode(NUMBER) },
        });
        assert.equal(verified.statusCode, 200);
        const accounts = await ctx.pool.query("SELECT 1 FROM customers WHERE subject = $1", [`phone:${phoneHash(TEST_PEPPER, NUMBER)}`]);
        assert.equal(accounts.rowCount, 1);
    });

    test("wrong codes, a missing start, and bad numbers are refused with the website's codes", async () => {
        const browser = new Browser(ctx);
        assert.equal((await browser.call("POST", "/v1/web/phone/verify", { code: "123456" })).body.code, "expired");
        assert.equal((await browser.call("POST", "/v1/web/phone/start", { phone: "12" })).body.code, "invalidPhone");
        assert.equal((await browser.call("POST", "/v1/web/phone/start", { phone: "+33612345678" })).body.code, "invalidPhone");
        ctx.clockOffsetMs += 60_000;
        assert.equal((await browser.call("POST", "/v1/web/phone/start", { phone: "+12065550111" })).status, 200);
        const real = ctx.sms.lastCode("+12065550111")!;
        const wrong = real === "000000" ? "111111" : "000000";
        const refused = await browser.call("POST", "/v1/web/phone/verify", { code: wrong });
        assert.equal(refused.status, 400);
        assert.equal(refused.body.code, "invalidCode");
        assert.equal((await browser.call("POST", "/v1/web/phone/verify", { code: real })).status, 200);
    });

    test("email codes sign in too", async () => {
        const browser = new Browser(ctx);
        ctx.clockOffsetMs += 60_000;
        const started = await browser.call("POST", "/v1/web/email/start", { email: " Sample.Diner@Example.com " });
        assert.deepEqual(started.body, { maskedEmail: "s•••@example.com" });
        const verified = await browser.call("POST", "/v1/web/email/verify", { code: ctx.email.lastCode("sample.diner@example.com") });
        assert.deepEqual(verified.body.identity, { kind: "account", method: "email", maskedEmail: "s•••@example.com" });
        assert.equal((await browser.call("POST", "/v1/web/email/start", { email: "nope" })).body.code, "invalidEmail");
    });

    test("signing out ends only this browser's session; signing back in restores the cards", async () => {
        const browser = new Browser(ctx);
        await signInByPhone(browser);
        assert.ok((await browser.call("GET", "/v1/web/me/cards")).body.cards.length >= 2);
        assert.equal((await browser.call("POST", "/v1/web/sign-out")).status, 204);
        assert.match(browser.lastSetCookie!, /^joeyy_web=; .*Max-Age=0/);
        assert.deepEqual((await browser.call("GET", "/v1/web/me/cards")).body, { identity: { kind: "anonymous" }, cards: [] });
        const back = await signInByPhone(browser);
        assert.ok(back.body.restoredCards >= 2);
        assert.deepEqual(back.body.moved, []);
    });
});

describe("profile and account", () => {
    test("a signed-in diner can set and clear a name; an anonymous browser can't", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-profile");
        const anonymous = new Browser(ctx);
        await anonymous.tap(tagUid, next());
        assert.equal((await anonymous.call("PUT", "/v1/web/me/profile", { displayName: "Sam" })).status, 404);

        const browser = new Browser(ctx);
        ctx.clockOffsetMs += 60_000;
        await browser.call("POST", "/v1/web/phone/start", { phone: "+12065550122" });
        await browser.call("POST", "/v1/web/phone/verify", { code: ctx.sms.lastCode("+12065550122") });
        const named = await browser.call("PUT", "/v1/web/me/profile", { displayName: "  Zoë   O'Neil " });
        assert.equal(named.body.displayName, "Zoë O'Neil");
        assert.equal((await browser.call("GET", "/v1/web/me/cards")).body.identity.displayName, "Zoë O'Neil");
        assert.equal((await browser.call("PUT", "/v1/web/me/profile", { displayName: "<script>" })).body.code, "invalidName");
        assert.equal((await browser.call("PUT", "/v1/web/me/profile", { displayName: "x".repeat(41) })).status, 400);
        const cleared = await browser.call("PUT", "/v1/web/me/profile", { displayName: "" });
        assert.equal(cleared.body.displayName, undefined);
    });

    test("deleting the account removes everything on it and signs out every browser", async () => {
        const { tagUid } = await businessWithStand(ctx, "owner-delete", 3);
        const NUMBER = "+12065550133";
        const first = new Browser(ctx);
        const second = new Browser(ctx);
        for (const browser of [first, second]) {
            await browser.tap(tagUid, next());
            ctx.clockOffsetMs += 60_000;
            await browser.call("POST", "/v1/web/phone/start", { phone: NUMBER });
            await browser.call("POST", "/v1/web/phone/verify", { code: ctx.sms.lastCode(NUMBER) });
        }
        // The app's session for the same number.
        ctx.clockOffsetMs += 60_000;
        await ctx.app.inject({ method: "POST", url: "/v1/auth/phone/start", payload: { phoneNumber: NUMBER } });
        const app = await ctx.app.inject({
            method: "POST",
            url: "/v1/auth/phone/verify",
            payload: { role: "customer", phoneNumber: NUMBER, code: ctx.sms.lastCode(NUMBER) },
        });
        const { refreshToken } = app.json();
        const account = await customerOf(first.cookie);

        assert.equal((await new Browser(ctx).call("DELETE", "/v1/web/me")).status, 404);
        assert.equal((await first.call("DELETE", "/v1/web/me")).status, 204);
        assert.match(first.lastSetCookie!, /Max-Age=0/);

        assert.equal((await ctx.pool.query("SELECT 1 FROM customers WHERE id = $1", [account!.id])).rowCount, 0);
        assert.equal((await ctx.pool.query("SELECT 1 FROM cards WHERE customer_id = $1", [account!.id])).rowCount, 0);
        assert.deepEqual((await second.call("GET", "/v1/web/me/cards")).body, { identity: { kind: "anonymous" }, cards: [] });
        const refreshed = await ctx.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
        assert.equal(refreshed.statusCode, 401);
    });
});

describe("without sign-in options", () => {
    test("code sign-in answers 503", async () => {
        const bare = await setUp({ signIn: undefined });
        try {
            const browser = new Browser(bare);
            const response = await browser.call("POST", "/v1/web/phone/start", { phone: "+12065550100" });
            assert.equal(response.status, 503);
            assert.equal(response.body.code, "signInUnavailable");
        } finally {
            await bare.close();
        }
    });
});
