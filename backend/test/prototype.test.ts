import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.ts";
import { nativeConfigFromEnv } from "../src/native/config.ts";
import { assertNativeReady, type NativeServices } from "../src/native/index.ts";
import { NativeStore, digest } from "../src/native/store.ts";
import { NativeWallet } from "../src/native/wallet.ts";
import { migrate } from "../src/migrate.ts";
import { verifyTag } from "../support.mjs";
import { setUp, type TestContext } from "./helpers.ts";

const uid = "04DE5F1EACC040", cafeID = randomUUID();
const password = "ordinary-fixture-password";
interface Session { token: string; username: string; prototype: true }
interface Read { url: string; requestId: string; counter: number; ciphertext: string }
const verifierResponses = new Map<string, { status: number; body: Record<string, string | number> }>();
const logs: string[] = [];
let ctx: TestContext, app: ReturnType<typeof buildApp>, accountApp: ReturnType<typeof buildApp>, services: NativeServices;
let verifier: ReturnType<typeof createServer>, verifierURL: string;
let nextCounter = 1, verificationRequests = 0, renderCalls = 0, signingBroken = true, authAddress = 1;
before(async () => {
    assert.ok(["127.0.0.1", "localhost"].includes(process.env.PGHOST ?? ""), "Prototype tests require explicitly configured local PostgreSQL.");
    ctx = await setUp();
    verifier = createServer((request, reply) => {
        verificationRequests++;
        const url = new URL(request.url ?? "/", "http://verifier");
        assert.equal(url.pathname, "/api/tagtt");
        const fixture = verifierResponses.get(url.searchParams.get("e") ?? "");
        reply.writeHead(fixture?.status ?? 200, { "content-type": "application/json" });
        reply.end(JSON.stringify(fixture?.body ?? { error: "fixture signature mismatch" }));
    });
    verifier.listen(0, "127.0.0.1");
    await once(verifier, "listening");
    const address = verifier.address();
    assert.ok(address && typeof address !== "string");
    verifierURL = `http://127.0.0.1:${address.port}`;
    const store = new NativeStore(ctx.pool, true);
    const wallet = new NativeWallet(store, {
        baseURL: "https://prototype.example.test", passType: "pass.com.example.prototype",
        render: async (card) => {
            renderCalls++;
            if (signingBroken) throw new Error("Fixture signer offline");
            return Buffer.from(`fixture-pass:${card.id}:${card.version}`);
        },
        sendPush: async () => false,
    });
    services = { store, wallet, prototypeMode: true, factoryTest: true, verify: (url) => verifyTag(verifierURL, url) };
    app = buildApp({
        pool: ctx.pool, auth: ctx.signer.config, images: ctx.images, native: services,
        logger: { level: "info", stream: { write: (message: string) => { logs.push(message); } } },
    });
    const ordinaryStore = new NativeStore(ctx.pool);
    accountApp = buildApp({
        pool: ctx.pool, auth: ctx.signer.config, images: ctx.images,
        native: { ...services, prototypeMode: false, store: ordinaryStore, wallet: new NativeWallet(ordinaryStore, wallet.options) },
    });
    await app.ready();
    await accountApp.ready();
    await ctx.pool.query("INSERT INTO native_cafes(id,name,target) VALUES($1,'Anonymous hardware-test cafe',3)", [cafeID]);
    await ctx.pool.query("INSERT INTO native_tags(uid,cafe_id) VALUES($1,$2)", [uid, cafeID]);
});
after(async () => {
    await app?.close();
    await accountApp?.close();
    await ctx?.close();
    if (verifier?.listening) await new Promise<void>((done, reject) => verifier.close((error) => error ? reject(error) : done()));
});
function read(): Read {
    const counter = nextCounter++, ciphertext = randomBytes(16).toString("hex");
    // Opaque test vectors stand in for responses from the private verifier; production
    // routes still call the original verifyTag adapter, with no crypto implementation here.
    verifierResponses.set(ciphertext, { status: 200, body: { uid, read_ctr: counter, enc_mode: "AES" } });
    return { url: `https://expired-host.example/tagtt?e=${ciphertext}`, requestId: randomUUID(), counter, ciphertext };
}
async function call(path: string, method: "GET" | "POST" | "DELETE" = "GET", token?: string, payload?: object) {
    return app.inject({
        method, url: `/api/v1${path}`, payload,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        ...(["/prototype/session", "/accounts", "/sessions"].includes(path) ? { remoteAddress: `192.0.2.${authAddress++}` } : {}),
    });
}
async function start(token?: string): Promise<Session> {
    const response = await call("/prototype/session", "POST", token);
    assert.equal(response.statusCode, 200);
    return response.json<Session>();
}
function tap(session: Session, value: Read) {
    return call("/taps", "POST", session.token, { url: value.url, requestId: value.requestId });
}
async function customerCount() {
    return (await ctx.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM native_customers")).rows[0]!.count;
}

test("prototype mode is explicit, default-off, requires native support and rejects production before secrets are loaded", async () => {
    assert.equal(await nativeConfigFromEnv({}), undefined);
    assert.equal(await nativeConfigFromEnv({ NATIVE_PROTOTYPE_MODE: "0" }), undefined);
    await assert.rejects(nativeConfigFromEnv({ NATIVE_PROTOTYPE_MODE: "yes" }), /must be 0 or 1/);
    await assert.rejects(nativeConfigFromEnv({ NATIVE_PROTOTYPE_MODE: "1" }), /requires NATIVE_NFC_ENABLED=1/);
    await assert.rejects(nativeConfigFromEnv({ NATIVE_NFC_ENABLED: "0", NATIVE_PROTOTYPE_MODE: "1" }), /requires NATIVE_NFC_ENABLED=1/);
    await assert.rejects(nativeConfigFromEnv({
        NATIVE_NFC_ENABLED: "1", NATIVE_PROTOTYPE_MODE: "1", NODE_ENV: "production",
    }), /not allowed when NODE_ENV=production/);
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/v1/prototype/session" })).statusCode, 404);
    assert.equal((await accountApp.inject({ method: "POST", url: "/api/v1/prototype/session" })).statusCode, 404);
    assert.equal((await call("/healthz")).json().prototypeMode, true);
    assert.equal((await accountApp.inject({ method: "GET", url: "/api/v1/healthz" })).json().prototypeMode, false);
});

test("migration 0005 is explicit and additive, preserves existing credentials/session and defaults ordinary rows to false", async () => {
    const target = await setUp();
    try {
        const store = new NativeStore(target.pool);
        const account = await store.signup("before-prototype", password);
        const customer = await store.authenticate(`Bearer ${account.token}`);
        const before = (await target.pool.query("SELECT id,username,salt,password_hash FROM native_customers")).rows[0];
        await target.pool.query("ALTER TABLE native_customers DROP COLUMN is_prototype; DELETE FROM schema_migrations WHERE version='0005_native_prototype'");
        await assert.rejects(assertNativeReady(target.pool), /0005_native_prototype/);
        assert.deepEqual(await migrate(target.pool), ["0005_native_prototype"]);
        await assertNativeReady(target.pool);
        assert.deepEqual((await target.pool.query("SELECT id,username,salt,password_hash FROM native_customers")).rows[0], before);
        assert.equal((await store.authenticate(`Bearer ${account.token}`)).id, customer.id);
        assert.equal((await store.authenticate(`Bearer ${account.token}`)).isPrototype, false);
        assert.equal((await store.login("before-prototype", password)).username, account.username);
    } finally { await target.close(); }
});

test("anonymous session creates one marked technical owner with opaque hashed session and no credential request body", async () => {
    const before = await customerCount(), guest = await start();
    assert.deepEqual(Object.keys(guest).sort(), ["prototype", "token", "username"]);
    assert.equal(guest.prototype, true);
    assert.match(guest.username, /^nfc-[0-9a-f]{32}$/);
    assert.match(guest.token, /^[0-9a-f]{64}$/);
    const customer = await services.store.authenticate(`Bearer ${guest.token}`);
    assert.equal(customer.isPrototype, true);
    const row = (await ctx.pool.query("SELECT * FROM native_customers WHERE id=$1", [customer.id])).rows[0];
    assert.equal(row.is_prototype, true);
    assert.match(row.salt, /^[0-9a-f]{32}$/);
    assert.match(row.password_hash, /^[0-9a-f]{128}$/);
    assert.equal((await ctx.pool.query("SELECT 1 FROM native_sessions WHERE hash=$1", [guest.token])).rowCount, 0);
    assert.equal((await customerCount()) - before, 1);
    assert.deepEqual((await call("/cards", "GET", guest.token)).json(), { cards: [] });
    assert.equal((await call("/sessions", "POST", undefined, { username: guest.username, password })).statusCode, 401);
    assert.equal((await call("/prototype/session", "POST", undefined, { username: "not-an-account", password })).statusCode, 400);
    assert.equal((await customerCount()) - before, 1);
});

test("resume renews even an expired guest token without replacing identity, cards or pending request scope", async () => {
    const guest = await start(), customer = await services.store.authenticate(`Bearer ${guest.token}`), firstRead = read();
    const first = await tap(guest, firstRead);
    assert.equal(first.statusCode, 200);
    const earned = first.json();
    await ctx.pool.query("UPDATE native_sessions SET expires=0 WHERE hash=$1", [digest(guest.token)]);
    assert.equal((await call("/cards", "GET", guest.token)).statusCode, 401);
    const before = await customerCount(), callsBefore = verificationRequests;
    const resumed = await start(guest.token);
    assert.deepEqual(resumed, guest);
    assert.equal((await services.store.authenticate(`Bearer ${resumed.token}`)).id, customer.id);
    const sessions = (await ctx.pool.query("SELECT hash,expires FROM native_sessions WHERE customer_id=$1", [customer.id])).rows;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].hash, digest(guest.token));
    assert.ok(Number(sessions[0].expires) > Date.now());
    const retried = (await tap(resumed, firstRead)).json();
    assert.equal(retried.eventId, earned.eventId);
    assert.equal(retried.card.id, earned.card.id);
    assert.equal(retried.card.stamps, 1);
    assert.equal(retried.duplicate, true);
    assert.deepEqual(retried.verification, { verified: true, counter: firstRead.counter });
    assert.equal(verificationRequests, callsBefore);
    const secondRead = read();
    assert.equal((await tap(resumed, secondRead)).json().card.stamps, 2);
    const oldRetry = (await tap(resumed, firstRead)).json();
    assert.equal(oldRetry.card.stamps, 2, "retry returns current card, not a stale balance");
    assert.deepEqual(oldRetry.verification, { verified: true, counter: firstRead.counter }, "metadata comes from the original persisted event");
    assert.deepEqual(await Promise.all([start(guest.token), start(guest.token)]), [guest, guest]);
    assert.equal(await customerCount(), before);
});

test("invalid, revoked and regular-account tokens never resume or silently create another guest", async () => {
    const regular = (await call("/accounts", "POST", undefined, { username: "regular-prototype-test", password })).json<{ token: string; username: string }>();
    const regularCustomer = await services.store.authenticate(`Bearer ${regular.token}`);
    assert.equal(regularCustomer.isPrototype, false);
    const guest = await start(), before = await customerCount();
    assert.equal((await call("/prototype/session", "POST", regular.token)).statusCode, 401);
    assert.equal((await call("/prototype/session", "POST", "0".repeat(64))).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/prototype/session", headers: { authorization: "" } })).statusCode, 401);
    assert.equal((await call("/prototype/session", "POST", "invalid-token")).statusCode, 401);
    assert.equal((await call("/session", "DELETE", guest.token)).statusCode, 204);
    assert.equal((await call("/prototype/session", "POST", guest.token)).statusCode, 401);
    assert.equal(await customerCount(), before);
    assert.equal((await call("/sessions", "POST", undefined, { username: regular.username, password })).statusCode, 200);
    assert.equal((await accountApp.inject({
        method: "GET", url: "/api/v1/cards", headers: { authorization: `Bearer ${regular.token}` },
    })).statusCode, 200);
    // An expired ordinary token is not eligible for prototype renewal either.
    await ctx.pool.query("UPDATE native_sessions SET expires=0 WHERE hash=$1", [digest(regular.token)]);
    assert.equal((await call("/prototype/session", "POST", regular.token)).statusCode, 401);
    assert.equal(await customerCount(), before);
});

test("turning prototype mode off rejects retained guest bearers on every ordinary authenticated native route", async () => {
    const guest = await start(), callsBefore = verificationRequests;
    for (const [method, url, payload] of [
        ["GET", "/api/v1/cards", undefined],
        ["GET", `/api/v1/cards/${randomUUID()}/pass`, undefined],
        ["DELETE", "/api/v1/session", undefined],
        ["POST", "/api/v1/taps", { url: "https://expired-host.example/tagtt?e=0011", requestId: randomUUID() }],
    ] as const) {
        const response = await accountApp.inject({ method, url, payload, headers: { authorization: `Bearer ${guest.token}` } });
        assert.equal(response.statusCode, 401);
    }
    await assert.rejects(new NativeStore(ctx.pool).authenticate(`Bearer ${guest.token}`), { status: 401 });
    await assert.rejects(new NativeStore(ctx.pool).prototypeSession(`Bearer ${guest.token}`), { status: 404 });
    assert.equal(verificationRequests, callsBefore);
    assert.deepEqual(await start(guest.token), guest, "disabling acceptance never silently deletes or replaces the retained guest");
});

test("two guests own isolated cards while chip counters remain global and request IDs remain customer-scoped", async () => {
    const a = await start(), b = await start(), firstRead = read();
    const first = (await tap(a, firstRead)).json();
    assert.equal((await tap(b, { ...firstRead, requestId: randomUUID() })).statusCode, 409);
    const second = (await tap(b, { ...read(), requestId: firstRead.requestId })).json();
    assert.equal(first.card.stamps, 1);
    assert.equal(second.card.stamps, 1);
    assert.notEqual(first.card.id, second.card.id);
    assert.equal((await call("/cards", "GET", a.token)).json().cards[0].id, first.card.id);
    assert.equal((await call("/cards", "GET", b.token)).json().cards[0].id, second.card.id);
    assert.equal((await call(`/cards/${first.card.id}/pass`, "GET", b.token)).statusCode, 404);
    const partnerToken = await ctx.signer.sign("partner", "prototype-foreign-audience");
    assert.equal((await call("/cards", "GET", partnerToken)).statusCode, 401);
    assert.equal((await app.inject({
        method: "GET", url: "/v1/partner/business", headers: { authorization: `Bearer ${a.token}` },
    })).statusCode, 401);
});

test("invalid/tampered ciphertext, forged client metadata and invalid verifier output cannot award or advance counters", async () => {
    const guest = await start(), value = read();
    const before = (await ctx.pool.query("SELECT last_counter FROM native_tags WHERE uid=$1", [uid])).rows[0].last_counter;
    const tampered = new URL(value.url);
    tampered.searchParams.set("e", randomBytes(16).toString("hex"));
    const invalid = await call("/taps", "POST", guest.token, {
        url: tampered.toString(), requestId: randomUUID(), verification: { verified: true, counter: 9999 },
    });
    assert.equal(invalid.statusCode, 422, "HTTP-200 verifier error bodies are never successful reads");
    assert.equal((await call("/taps", "POST", guest.token, {
        url: "https://expired-host.example/tagtt?uid=04DE5F1EACC040&counter=9999", requestId: randomUUID(),
    })).statusCode, 400);
    verifierResponses.set(value.ciphertext, { status: 200, body: { uid: "invalid", read_ctr: value.counter, enc_mode: "AES" } });
    assert.equal((await tap(guest, value)).statusCode, 502);
    verifierResponses.set(value.ciphertext, { status: 503, body: { error: "fixture unavailable" } });
    assert.equal((await tap(guest, value)).statusCode, 503);
    assert.deepEqual((await call("/cards", "GET", guest.token)).json(), { cards: [] });
    assert.equal((await ctx.pool.query("SELECT last_counter FROM native_tags WHERE uid=$1", [uid])).rows[0].last_counter, before);
    const customer = await services.store.authenticate(`Bearer ${guest.token}`);
    assert.equal((await ctx.pool.query("SELECT 1 FROM native_events WHERE customer_id=$1", [customer.id])).rowCount, 0);
});

test("fresh verified reads count through full/rollover with accumulated rewards despite signing failure", async () => {
    const guest = await start(), callsBefore = renderCalls, stamps = [1, 2, 3, 1, 2, 3, 1], rewards = [0, 0, 1, 1, 1, 2, 2];
    let serial: string | undefined;
    for (const [index, expected] of stamps.entries()) {
        const value = read(), response = await tap(guest, value);
        assert.equal(response.statusCode, 200);
        const result = response.json();
        assert.deepEqual(Object.keys(result).sort(), ["card", "duplicate", "eventId", "verification"]);
        assert.deepEqual(result.verification, { verified: true, counter: value.counter });
        assert.equal(result.card.stamps, expected);
        assert.equal(result.card.rewardsAvailable, rewards[index]);
        if (serial) assert.equal(result.card.id, serial);
        serial = result.card.id;
        const retried = (await tap(guest, value)).json();
        assert.equal(retried.eventId, result.eventId);
        assert.equal(retried.duplicate, true);
        assert.equal(retried.card.stamps, expected);
        assert.equal((await tap(guest, { ...value, requestId: randomUUID() })).statusCode, 409);
    }
    assert.equal(renderCalls, callsBefore, "guest taps never synchronously invoke Wallet publication");
    assert.equal((await ctx.pool.query("SELECT 1 FROM native_wallet_passes WHERE serial=$1", [serial])).rowCount, 0);
});

test("concurrent guest retries are atomic and carry persisted verification metadata without rendering", async () => {
    const guest = await start(), value = read(), callsBefore = renderCalls;
    const responses = await Promise.all([tap(guest, value), tap(guest, value)]);
    assert.ok(responses.every((response) => response.statusCode === 200));
    const results = responses.map((response) => response.json());
    assert.equal(results[0].eventId, results[1].eventId);
    assert.equal(results.filter((result) => !result.duplicate).length, 1);
    for (const result of results) {
        assert.equal(result.card.stamps, 1);
        assert.deepEqual(result.verification, { verified: true, counter: value.counter });
    }
    assert.equal(renderCalls, callsBefore);
    assert.equal((await tap(guest, { ...read(), requestId: value.requestId })).statusCode, 409);
});

test("normal accounts retain their exact tap contract and post-commit Wallet 503, while guest passes remain manually publishable", async () => {
    const regular = (await call("/accounts", "POST", undefined, { username: "ordinary-wallet-test", password })).json<{ token: string; username: string }>();
    const value = read(), first = await call("/taps", "POST", regular.token, value);
    assert.equal(first.statusCode, 503);
    assert.equal((await call("/cards", "GET", regular.token)).json().cards[0].stamps, 1);
    signingBroken = false;
    try {
        const retried = await call("/taps", "POST", regular.token, value);
        assert.equal(retried.statusCode, 200);
        assert.deepEqual(Object.keys(retried.json()).sort(), ["card", "duplicate", "eventId"]);
        assert.equal(retried.json().duplicate, true);
        assert.equal(retried.json().card.stamps, 1);
        const guest = await start(), earned = (await tap(guest, read())).json();
        const downloaded = await call(`/cards/${earned.card.id}/pass`, "GET", guest.token);
        assert.equal(downloaded.statusCode, 200);
        assert.ok(downloaded.body.startsWith("fixture-pass:"));
        await services.wallet.reconcile(() => assert.fail("Unexpected fixture publication failure"));
        assert.ok(logs.every((line) => !line.includes(guest.token) && !line.includes(regular.token) && !line.includes(value.url) && !line.includes(password)));
    } finally { signingBroken = true; }
});
