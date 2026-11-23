import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.ts";
import { createPool } from "../src/db.ts";
import { HttpError } from "../support.mjs";
import { nativeConfigFromEnv } from "../src/native/config.ts";
import { assertNativeReady, scheduleNativeWorker, type NativeServices } from "../src/native/index.ts";
import { importNative } from "../src/native/import.ts";
import { NativeStore, digest } from "../src/native/store.ts";
import { NativeWallet, type PassRow } from "../src/native/wallet.ts";
import { renderPass } from "../wallet.mjs";
import { setUp, type TestContext } from "./helpers.ts";

const uid = "04DE5F1EACC040", uid2 = "04DE5F1EACC041", passType = "pass.com.example.native";
let ctx: TestContext, app: ReturnType<typeof buildApp>, services: NativeServices;
let signingBroken = false, pushState: "ok" | "offline" | "invalid" = "ok", verified = 0, delivered = 0;
const cafeID = randomUUID();
before(async () => {
    // Never let this test accidentally use the shared Azure database.
    assert.ok(["127.0.0.1", "localhost"].includes(process.env.PGHOST ?? ""), "Native tests require explicitly configured local PostgreSQL.");
    ctx = await setUp();
    const store = new NativeStore(ctx.pool);
    const wallet = new NativeWallet(store, {
        baseURL: "https://native.example.test", passType,
        render: async (card) => {
            if (signingBroken) throw new Error("Fixture signer offline");
            return Buffer.from(`signed-fixture:${card.id}:${card.version}`);
        },
        sendPush: async () => {
            delivered++;
            if (pushState === "offline") throw new Error("Fixture APNs offline");
            return pushState === "invalid";
        },
    });
    services = {
        store, wallet, factoryTest: true, prototypeMode: false,
        verify: async (url) => {
            verified++;
            const parsed = new URL(url), counter = parsed.searchParams.get("fixture");
            if (counter === "invalid") throw new HttpError(422, "Invalid signature.");
            // Delay exposes concurrent request-id and global replay races.
            await new Promise((done) => setTimeout(done, 10));
            return { uid: parsed.searchParams.has("second") ? uid2 : uid, counter: Number(counter) };
        },
    };
    app = buildApp({ pool: ctx.pool, auth: ctx.signer.config, images: ctx.images, native: services });
    await app.ready();
    await ctx.pool.query("INSERT INTO native_cafes(id,name,target) VALUES($1,'Hardware Test Cafe',3)", [cafeID]);
    await ctx.pool.query("INSERT INTO native_tags(uid,cafe_id) VALUES($1,$3),($2,$3)", [uid, uid2, cafeID]);
});
after(async () => {
    await app?.close();
    await ctx?.close();
});
const password = "native-fixture-password";
let authAddress = 1;
const tap = (counter: number | string, requestId = randomUUID(), second = false) => ({
    url: `https://expired-host.example/tagtt?fixture=${counter}${second ? "&second=1" : ""}`, requestId,
});
async function call(path: string, method: "GET" | "POST" | "DELETE" = "GET", token?: string, payload?: object) {
    return app.inject({
        method, url: `/api/v1${path}`, headers: token ? { authorization: `Bearer ${token}` } : {}, payload,
        ...(["/accounts", "/sessions"].includes(path) ? { remoteAddress: `192.0.2.${authAddress++}` } : {}),
    });
}
async function account(username: string) {
    const response = await call("/accounts", "POST", undefined, { username, password });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ token: string; username: string }>();
}

test("native feature is opt-in; disabled routes stay absent, partner auth remains independent", async () => {
    assert.equal((await ctx.app.inject({ method: "GET", url: "/api/v1/cards" })).statusCode, 404);
    assert.equal((await ctx.app.inject({ method: "GET", url: "/api/v1/healthz" })).statusCode, 404);
    assert.equal((await call("/prototype/session", "POST")).statusCode, 404);
    assert.equal((await ctx.app.inject({ method: "GET", url: `/wallet/v1/passes/${passType}/${randomUUID()}` })).statusCode, 404);
    assert.equal((await ctx.app.inject({ method: "GET", url: "/healthz" })).json().nativeNfc.enabled, false);
    assert.equal((await app.inject({ method: "GET", url: "/healthz" })).json().nativeNfc.factoryKeyTest, true);
    const partnerToken = await ctx.signer.sign("partner", "native-test-partner");
    assert.equal((await call("/cards", "GET", partnerToken)).statusCode, 401);
    const native = await account("auth-domain-test");
    assert.equal((await app.inject({ method: "GET", url: "/v1/partner/business", headers: { authorization: `Bearer ${native.token}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/v1/partner/business", headers: { authorization: `Bearer ${partnerToken}` } })).statusCode, 404);
    await assertNativeReady(ctx.pool);
});

test("native readiness is public and secret-free, checks its own persistence, and returns 503 for an unready schema", async () => {
    const ready = await call("/healthz");
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ok", factoryKeyTest: true, publicBaseURL: "https://native.example.test", prototypeMode: false });
    assert.equal(ready.headers["cache-control"], "no-store");
    const spoofed = await app.inject({
        method: "GET", url: "/api/v1/healthz",
        headers: { host: "wrong.example.test", "x-forwarded-host": "wrong-forwarded.example.test" },
    });
    assert.equal(spoofed.json().publicBaseURL, "https://native.example.test");
    const pool = createPool(process.env, { searchPath: `missing_native_${randomUUID().replaceAll("-", "")}` });
    const store = new NativeStore(pool);
    const unready = buildApp({
        pool, auth: ctx.signer.config, images: ctx.images,
        native: { ...services, store, wallet: new NativeWallet(store, services.wallet.options), factoryTest: false },
    });
    try {
        const response = await unready.inject({ method: "GET", url: "/api/v1/healthz" });
        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.json(), { status: "unavailable", factoryKeyTest: false, publicBaseURL: "https://native.example.test", prototypeMode: false });
    } finally { await unready.close(); await pool.end(); }
});

test("native readiness returns 503 when the private verifier is down", async () => {
    const verifierDown = buildApp({
        pool: ctx.pool, auth: ctx.signer.config, images: ctx.images,
        native: { ...services, verifierReady: async () => { throw new Error("verifier down"); } },
    });
    try {
        const response = await verifierDown.inject({ method: "GET", url: "/api/v1/healthz" });
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().status, "unavailable");
        assert.doesNotMatch(response.body, /verifier down/);
    } finally { await verifierDown.close(); }
});

test("configuration fails explicitly before startup with missing settings; factory keys require two explicit gates", async () => {
    assert.equal(await nativeConfigFromEnv({}), undefined);
    assert.equal(await nativeConfigFromEnv({ NATIVE_NFC_ENABLED: "0" }), undefined);
    await assert.rejects(nativeConfigFromEnv({ NATIVE_NFC_ENABLED: "yes" }), /0 or 1/);
    await assert.rejects(nativeConfigFromEnv({ NATIVE_NFC_ENABLED: "1" }), /PUBLIC_BASE_URL/);
    const base = { NATIVE_NFC_ENABLED: "1", PUBLIC_BASE_URL: "https://native.example.test", SDM_BACKEND_URL: "http://127.0.0.1:5005" };
    await assert.rejects(nativeConfigFromEnv(base), /NATIVE_NFC_KEY_MODE/);
    await assert.rejects(nativeConfigFromEnv({ ...base, NATIVE_NFC_KEY_MODE: "factory-test" }), /FACTORY_KEY_TEST/);
    await assert.rejects(nativeConfigFromEnv({ ...base, NATIVE_NFC_KEY_MODE: "provisioned", FACTORY_KEY_TEST: "1" }), /FACTORY_KEY_TEST/);
    await assert.rejects(nativeConfigFromEnv({ ...base, NATIVE_NFC_KEY_MODE: "provisioned" }), /PASS_TYPE_ID/);
    await assert.rejects(nativeConfigFromEnv({ ...base, SDM_BACKEND_URL: "http://public.example.com", NATIVE_NFC_KEY_MODE: "provisioned" }), /private HTTP/);
    const result = spawnSync(process.execPath, ["src/server.ts"], {
        cwd: resolve("."), encoding: "utf8",
        env: { ...process.env, NATIVE_NFC_ENABLED: "1", PUBLIC_BASE_URL: "" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Native NFC requires PUBLIC_BASE_URL/);
});

test("password accounts, native HTTP errors, expiry/logout, isolation, UUID normalization, global replay, rollover and accumulated rewards", async () => {
    assert.equal((await call("/cards")).statusCode, 401);
    assert.equal((await call("/accounts", "POST", undefined, { username: "bad", password: "short" })).statusCode, 400);
    const a = await account("native-a"), b = await account("native-b");
    assert.deepEqual(Object.keys(a).sort(), ["token", "username"]);
    assert.equal((await call("/accounts", "POST", undefined, { username: "NATIVE-A", password })).statusCode, 409);
    assert.equal((await call("/sessions", "POST", undefined, { username: "native-a", password: "incorrect-password" })).statusCode, 401);
    const login = await call("/sessions", "POST", undefined, { username: "NATIVE-A", password });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().username, "native-a");
    assert.deepEqual((await call("/cards", "GET", a.token)).json(), { cards: [] });
    const original = tap(1), accepted = await call("/taps", "POST", a.token, original);
    assert.equal(accepted.statusCode, 200, accepted.body);
    const earned = accepted.json();
    assert.deepEqual(Object.keys(earned.card).sort(), ["cafeId", "cafeName", "id", "rewardsAvailable", "stamps", "target", "updatedAt"]);
    assert.equal(earned.card.stamps, 1);
    assert.equal((await call(`/cards/${earned.card.id.toUpperCase()}/pass`, "GET", a.token)).statusCode, 200);
    assert.equal((await call(`/cards/${earned.card.id}/pass`, "GET", b.token)).statusCode, 404);
    const before = verified;
    const retry = (await call("/taps", "POST", a.token, { ...original, requestId: original.requestId.toUpperCase() })).json();
    assert.equal(retry.eventId, earned.eventId);
    assert.equal(retry.duplicate, true);
    assert.equal(verified, before, "retry never re-verifies consumed encrypted data");
    assert.equal((await call("/taps", "POST", a.token, tap(2, original.requestId))).statusCode, 409);
    assert.equal((await call("/taps", "POST", a.token, tap(1))).statusCode, 409);
    assert.equal((await call("/taps", "POST", b.token, tap(1))).statusCode, 409);
    const personal = (await call("/taps", "POST", b.token, tap(2))).json();
    assert.notEqual(personal.card.id, earned.card.id);
    assert.equal(personal.card.stamps, 1);
    assert.equal((await call("/taps", "POST", a.token, tap("invalid"))).statusCode, 422);
    assert.equal((await ctx.pool.query("SELECT last_counter FROM native_tags WHERE uid=$1", [uid])).rows[0].last_counter, 2);
    await call("/taps", "POST", a.token, tap(3));
    const full = (await call("/taps", "POST", a.token, tap(4))).json();
    assert.equal(full.card.stamps, 3);
    assert.equal(full.card.rewardsAvailable, 1);
    assert.equal((await call("/cards", "GET", a.token)).json().cards[0].stamps, 3, "full card retained until next stamp");
    const rollover = (await call("/taps", "POST", a.token, tap(5))).json();
    assert.equal(rollover.card.stamps, 1);
    assert.equal(rollover.card.rewardsAvailable, 1);
    assert.equal(rollover.card.id, earned.card.id);
    await call("/taps", "POST", a.token, tap(6));
    assert.equal((await call("/taps", "POST", a.token, tap(7))).json().card.rewardsAvailable, 2);
    const customer = await services.store.authenticate(`Bearer ${a.token}`);
    assert.equal((await ctx.pool.query("SELECT 1 FROM native_sessions WHERE hash=$1", [a.token])).rowCount, 0);
    assert.notEqual((await ctx.pool.query("SELECT password_hash FROM native_customers WHERE id=$1", [customer.id])).rows[0].password_hash, password);
    await ctx.pool.query("UPDATE native_sessions SET expires=0 WHERE hash=$1", [digest(a.token)]);
    assert.equal((await call("/cards", "GET", a.token)).statusCode, 401);
    const loginToken = login.json().token;
    assert.equal((await call("/session", "DELETE", loginToken)).statusCode, 204);
    assert.equal((await call("/cards", "GET", loginToken)).statusCode, 401);
});

test("concurrent same/different request IDs and chips are atomic across independent PostgreSQL services", async () => {
    const a = await account("concurrent-native"), b = await account("concurrent-other");
    const customer = await services.store.authenticate(`Bearer ${a.token}`);
    const independentStore = new NativeStore(ctx.pool);
    const request = tap(10);
    const verifiedTag = { uid, counter: 10 };
    const results = await Promise.all([
        services.store.award(customer.id, request.requestId, request.url, verifiedTag),
        independentStore.award(customer.id, request.requestId, request.url, verifiedTag),
    ]);
    assert.equal(results[0]!.eventId, results[1]!.eventId);
    assert.equal(results.filter((result) => !result.duplicate).length, 1);
    const httpRequest = tap(11);
    const http = await Promise.all([call("/taps", "POST", a.token, httpRequest), call("/taps", "POST", a.token, httpRequest)]);
    assert.ok(http.every((response) => response.statusCode === 200));
    assert.equal(http[0]!.json().eventId, http[1]!.json().eventId);
    const collisions = await Promise.all([call("/taps", "POST", a.token, tap(12)), call("/taps", "POST", b.token, tap(12))]);
    assert.deepEqual(collisions.map((r) => r.statusCode).sort(), [200, 409]);
    const collisionID = randomUUID();
    const differentData = await Promise.all([
        call("/taps", "POST", a.token, tap(13, collisionID)),
        call("/taps", "POST", a.token, tap(1, collisionID, true)),
    ]);
    assert.deepEqual(differentData.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM native_events WHERE customer_id=$1 AND request_id=$2", [customer.id, collisionID])).rows[0].n, 1);
});

test("post-commit publication failures, restart reconciliation and durable bytea never double-award or rotate auth", async () => {
    const a = await account("publication-native"), first = tap(20);
    signingBroken = true;
    assert.equal((await call("/taps", "POST", a.token, first)).statusCode, 503);
    const cards = (await call("/cards", "GET", a.token)).json().cards;
    assert.equal(cards[0].stamps, 1);
    signingBroken = false;
    const retry = (await call("/taps", "POST", a.token, first)).json();
    assert.equal(retry.duplicate, true);
    assert.equal(retry.card.stamps, 1);
    const original = await services.wallet.publish(retry.card.id);
    const pending = tap(21);
    signingBroken = true;
    assert.equal((await call("/taps", "POST", a.token, pending)).statusCode, 503);
    signingBroken = false;
    // A genuinely new pool represents a restarted process, not in-memory state.
    const schema = (await ctx.pool.query("SELECT current_schema() AS name")).rows[0].name;
    const restartedPool = createPool(process.env, { searchPath: schema });
    try {
        const restarted = new NativeWallet(new NativeStore(restartedPool), services.wallet.options);
        await restarted.reconcile(() => assert.fail("Unexpected publication failure"));
        const recovered = await restarted.publish(retry.card.id);
        assert.equal(recovered.token, original.token);
        assert.notEqual(recovered.revision, original.revision);
        assert.ok(BigInt(recovered.change_tag) > BigInt(original.change_tag));
        assert.ok(recovered.bytes?.toString().startsWith("signed-fixture:"));
        assert.equal((await restarted.store.card(retry.card.id)).stamps, 2);
    } finally { await restartedPool.end(); }
});

test("Wallet authorization, registration, updates, conditional downloads, token rotation, APNs retry and device invalidation", async () => {
    const a = await account("wallet-native");
    const result = (await call("/taps", "POST", a.token, tap(30))).json();
    const pass = await services.wallet.publish(result.card.id);
    const registration = `/wallet/v1/devices/device-fixture/registrations/${passType}/${pass.serial.toUpperCase()}`;
    const authorization = `ApplePass ${pass.token}`, pushToken = "a".repeat(64);
    const invoke = (url: string, method: "GET" | "POST" | "DELETE" = "GET", auth = false, payload?: object, headers = {}) =>
        app.inject({ method, url, headers: { ...(auth ? { authorization } : {}), ...headers }, payload });
    assert.equal((await invoke(registration, "POST", false, { pushToken })).statusCode, 401);
    assert.equal((await invoke(registration, "POST", true, { pushToken: "invalid" })).statusCode, 400);
    assert.equal((await invoke(registration, "POST", true, { pushToken })).statusCode, 201);
    const before = delivered;
    assert.equal((await services.wallet.flush()).failed, 0);
    assert.equal(delivered, before + 1);
    assert.equal((await invoke(registration, "POST", true, { pushToken })).statusCode, 200);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM native_wallet_jobs WHERE device='device-fixture'")).rows[0].n, 0);
    const changesURL = `/wallet/v1/devices/device-fixture/registrations/${passType}`;
    const changes = (await invoke(changesURL)).json();
    assert.deepEqual(changes.serialNumbers, [pass.serial]);
    assert.equal((await invoke(`${changesURL}?passesUpdatedSince=${changes.lastUpdated}`)).statusCode, 204);
    assert.equal((await invoke(`${changesURL}?passesUpdatedSince=oops`)).statusCode, 400);
    assert.equal((await invoke(`/wallet/v1/devices/unknown/registrations/${passType}`)).statusCode, 204);
    const downloadURL = `/wallet/v1/passes/${passType}/${pass.serial.toUpperCase()}`;
    assert.equal((await invoke(downloadURL)).statusCode, 401);
    assert.equal((await invoke(downloadURL.replace(passType, "pass.wrong"), "GET", true)).statusCode, 401);
    const downloaded = await invoke(downloadURL, "GET", true);
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.headers["content-type"], "application/vnd.apple.pkpass");
    assert.deepEqual(downloaded.rawPayload, pass.bytes);
    assert.equal((await invoke(downloadURL, "GET", true, undefined, { "if-none-match": downloaded.headers.etag })).statusCode, 304);
    assert.equal((await invoke(downloadURL, "GET", true, undefined, { "if-modified-since": downloaded.headers["last-modified"] })).statusCode, 304);
    await call("/taps", "POST", a.token, tap(31));
    const updated = (await invoke(`${changesURL}?passesUpdatedSince=${changes.lastUpdated}`)).json();
    assert.ok(BigInt(updated.lastUpdated) > BigInt(changes.lastUpdated));
    const newOrigin = new NativeWallet(services.store, { ...services.wallet.options, baseURL: "https://replacement.example.test" });
    const republished = await newOrigin.publish(pass.serial);
    assert.equal(republished.token, pass.token);
    assert.ok(BigInt(republished.change_tag) > BigInt(updated.lastUpdated), "origin-only republication advances the Wallet update cursor");
    assert.deepEqual((await newOrigin.changes("device-fixture", passType, updated.lastUpdated))?.serialNumbers, [pass.serial]);
    await services.wallet.publish(pass.serial);
    pushState = "offline";
    assert.equal((await services.wallet.flush()).failed, 1);
    const failed = (await ctx.pool.query("SELECT attempts,next_attempt FROM native_wallet_jobs WHERE device='device-fixture'")).rows[0];
    assert.equal(failed.attempts, 1);
    assert.ok(Number(failed.next_attempt) > Date.now());
    await invoke(registration, "POST", true, { pushToken: "b".repeat(64) });
    assert.equal((await ctx.pool.query("SELECT attempts FROM native_wallet_jobs WHERE device='device-fixture'")).rows[0].attempts, 0);
    pushState = "invalid";
    await services.wallet.flush();
    assert.equal((await ctx.pool.query("SELECT 1 FROM native_wallet_devices WHERE device='device-fixture'")).rowCount, 0);
    assert.equal((await ctx.pool.query("SELECT 1 FROM native_wallet_registrations WHERE device='device-fixture'")).rowCount, 0);
    pushState = "ok";
    assert.equal((await invoke(registration, "POST", true, { pushToken })).statusCode, 201);
    assert.equal((await invoke(registration, "DELETE", true)).statusCode, 200);
    assert.equal((await ctx.pool.query("SELECT 1 FROM native_wallet_jobs WHERE device='device-fixture'")).rowCount, 0);
    assert.equal((await invoke("/wallet/v1/log", "POST", false, { logs: ["Fixture diagnostics deliberately not logged"] })).statusCode, 200);
});

test("Wallet publication cursors cannot overtake an uncommitted change on another card", async () => {
    const schema = (await ctx.pool.query<{ name: string }>("SELECT current_schema() AS name")).rows[0]!.name;
    const firstPool = createPool(process.env, { searchPath: schema, max: 1 });
    const secondPool = createPool(process.env, { searchPath: schema, max: 1 });
    const gate = await ctx.pool.connect();
    const gateKey = "hashtext('joeyy.test.native-wallet.publication-gate'),hashtext(current_schema())";
    const device = "cursor-order-device";
    const rendered: string[] = [];
    const options = {
        ...services.wallet.options,
        render: async (card: Parameters<typeof services.wallet.options.render>[0], token: string) => {
            rendered.push(card.id);
            return services.wallet.options.render(card, token);
        },
    };
    const firstWallet = new NativeWallet(new NativeStore(firstPool), options);
    const secondWallet = new NativeWallet(new NativeStore(secondPool), options);
    const publications: Promise<PromiseSettledResult<PassRow>[]>[] = [];
    const serials = [randomUUID(), randomUUID()];
    let gateHeld = false, triggerInstalled = false;
    const waitForAdvisoryBlock = async (waiter: number, holder: number) => {
        const deadline = Date.now() + 5000;
        do {
            const { rows: [state] } = await ctx.pool.query<{ blocked: boolean }>(
                `SELECT EXISTS(
                    SELECT 1 FROM pg_locks w JOIN pg_locks h
                      ON h.locktype=w.locktype AND h.database=w.database AND h.classid=w.classid
                     AND h.objid=w.objid AND h.objsubid=w.objsubid
                    WHERE w.locktype='advisory' AND w.pid=$1 AND h.pid=$2 AND NOT w.granted AND h.granted
                 ) AS blocked`, [waiter, holder]);
            if (state?.blocked) return;
            await new Promise((done) => setTimeout(done, 10));
        } while (Date.now() < deadline);
        assert.fail(`Expected PostgreSQL backend ${waiter} to wait for an advisory lock held by ${holder}.`);
    };
    try {
        for (const [index, serial] of serials.entries()) {
            const account = await services.store.signup(`cursor-order-${index}`, password);
            const customer = await services.store.authenticate(`Bearer ${account.token}`);
            await ctx.pool.query(
                "INSERT INTO native_cards(id,customer_id,cafe_id,stamps,updated_at) VALUES($1,$2,$3,1,$4)",
                [serial, customer.id, cafeID, new Date().toISOString()]);
            await services.wallet.publish(serial);
            await services.wallet.register(device, serial, "d".repeat(64));
        }
        const baseline = await services.wallet.changes(device, passType, undefined);
        assert.ok(baseline);
        await ctx.pool.query("UPDATE native_cards SET version=version+1 WHERE id=ANY($1::uuid[])", [serials]);
        await ctx.pool.query(`
            CREATE FUNCTION test_wallet_publication_gate() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_advisory_xact_lock(${gateKey});
                RETURN NEW;
            END;
            $$;
            CREATE TRIGGER test_wallet_publication_gate AFTER UPDATE ON native_wallet_passes
            FOR EACH ROW WHEN (NEW.serial='${serials[0]}'::uuid AND NEW.change_tag<>OLD.change_tag)
            EXECUTE FUNCTION test_wallet_publication_gate();
        `);
        triggerInstalled = true;
        await gate.query(`SELECT pg_advisory_lock(${gateKey})`);
        gateHeld = true;
        const gatePID = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await firstPool.query("SET statement_timeout='10s'");
        await secondPool.query("SET statement_timeout='10s'");
        const firstPID = (await firstPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        const secondPID = (await secondPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        const firstPublication = Promise.allSettled([firstWallet.publish(serials[0]!)]);
        publications.push(firstPublication);
        // AFTER UPDATE means A has already allocated its new sequence value.
        await waitForAdvisoryBlock(firstPID, gatePID);
        const secondPublication = Promise.allSettled([secondWallet.publish(serials[1]!)]);
        publications.push(secondPublication);
        await waitForAdvisoryBlock(secondPID, firstPID);
        assert.deepEqual(rendered, serials, "different-card rendering completes before the global publication lock");
        assert.equal(await services.wallet.changes(device, passType, baseline.lastUpdated), undefined,
            "a polling device cannot advance its cursor past A's uncommitted change");
        await gate.query(`SELECT pg_advisory_unlock(${gateKey})`);
        gateHeld = false;
        const [first] = await firstPublication, [second] = await secondPublication;
        assert.ok(first?.status === "fulfilled");
        assert.ok(second?.status === "fulfilled");
        assert.ok(BigInt(first.value.change_tag) < BigInt(second.value.change_tag));
        const changes = await services.wallet.changes(device, passType, baseline.lastUpdated);
        assert.deepEqual(changes?.serialNumbers, serials, "both committed publications remain visible after the previous cursor");
        assert.equal(changes?.lastUpdated, second.value.change_tag);
        assert.equal(await services.wallet.changes(device, passType, changes?.lastUpdated), undefined);
    } finally {
        if (gateHeld) await gate.query(`SELECT pg_advisory_unlock(${gateKey})`);
        await Promise.all(publications);
        if (triggerInstalled) await ctx.pool.query(
            "DROP TRIGGER test_wallet_publication_gate ON native_wallet_passes; DROP FUNCTION test_wallet_publication_gate()");
        for (const serial of serials) await services.wallet.unregister(device, serial);
        gate.release();
        await Promise.all([firstPool.end(), secondPool.end()]);
    }
});

test("Fastify enforces native body limits/malformed JSON without consuming raw streams or logging sensitive paths", async () => {
    const response = await app.inject({ method: "POST", url: "/wallet/v1/log", payload: { logs: ["x".repeat(17_000)] } });
    assert.equal(response.statusCode, 413);
    const malformed = await app.inject({ method: "POST", url: "/api/v1/accounts", headers: { "content-type": "application/json" }, payload: "{" });
    assert.equal(malformed.statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/wallet/v1/log", payload: [] })).statusCode, 400);
    const directory = resolve(".dev/native-test-logs");
    await mkdir(directory, { recursive: true });
    const logPath = join(directory, `${randomUUID()}.log`);
    const loggedApp = buildApp({
        pool: ctx.pool, auth: ctx.signer.config, images: ctx.images, native: services,
        logger: { level: "info", file: logPath },
    });
    try {
        await loggedApp.inject({ method: "POST", url: `/wallet/v1/devices/secret-device/registrations/${passType}/${randomUUID()}`, payload: { pushToken: "c".repeat(64) } });
        await loggedApp.inject({ method: "POST", url: "/wallet/v1/log", payload: { logs: ["secret-diagnostic"] } });
        await loggedApp.close();
        const logs = await readFile(logPath, "utf8");
        assert.doesNotMatch(logs, /secret-device|secret-diagnostic|cccccccc/);
    } finally { await loggedApp.close(); await rm(logPath, { force: true }); }
});

test("worker catches transient failures, retries dirty publications and stops cleanly", async () => {
    const a = await account("worker-native");
    const customer = await services.store.authenticate(`Bearer ${a.token}`);
    const request = tap(40);
    await services.store.award(customer.id, request.requestId, request.url, { uid, counter: 40 });
    let warnings = 0;
    signingBroken = true;
    const worker = scheduleNativeWorker(services, { warn: () => { warnings++; } }, 20);
    try {
        const deadline = Date.now() + 5000;
        while (!warnings && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
        assert.ok(warnings > 0);
        signingBroken = false;
        const cards = await services.store.cards(customer.id);
        while (Date.now() < deadline) {
            const ready = await ctx.pool.query("SELECT 1 FROM native_wallet_passes WHERE serial=$1 AND bytes IS NOT NULL", [cards[0]!.id]);
            if (ready.rowCount) break;
            await new Promise((done) => setTimeout(done, 20));
        }
    } finally { signingBroken = false; await worker.stop(); }
    const cards = await services.store.cards(customer.id);
    const pass = (await ctx.pool.query("SELECT version,bytes FROM native_wallet_passes WHERE serial=$1", [cards[0]!.id])).rows[0];
    assert.equal(pass.version, cards[0]!.version, "the worker, not a foreground publish, completed reconciliation");
    assert.ok(pass.bytes.length);
});

test("legacy importer dry-run/apply preserves credentials, sessions, events, counters, bytes, Wallet auth/registrations/jobs; refuses overwrite", async () => {
    // Separate empty schema; do not touch the live legacy database or its certificates.
    const target = await setUp();
    const directory = await mkdtemp(resolve(".dev/native-import-test-"));
    const sourcePath = join(directory, "customers.sqlite");
    const customerID = randomUUID(), importedCafe = randomUUID(), cardID = randomUUID(), eventID = randomUUID(), requestID = randomUUID();
    const revision = randomUUID(), token = "b".repeat(64), bearer = "c".repeat(64), expires = Date.now() + 86400_000;
    // Use the real retained legacy store to produce a representative source fixture.
    const { CustomerStore } = await import("../store.mjs");
    const { CustomerWallet } = await import("../wallet.mjs");
    const legacy = new CustomerStore(sourcePath);
    let legacyClosed = false;
    new CustomerWallet({ store: legacy, dataDir: directory, baseURL: "https://old.example.test", passType });
    try {
        const fixture = await legacy.signup("imported-native", password);
        const sourceCustomer = legacy.db.prepare("SELECT * FROM customers").get();
        assert.ok(sourceCustomer);
        legacy.db.prepare("DELETE FROM sessions").run();
        legacy.db.prepare("UPDATE customers SET id=?").run(customerID);
        legacy.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(digest(bearer), customerID, expires);
        legacy.db.prepare("INSERT INTO cafes VALUES(?,?,3)").run(importedCafe, "Imported hardware cafe");
        legacy.db.prepare("INSERT INTO tags VALUES(?,?,77)").run(uid, importedCafe);
        legacy.db.prepare("INSERT INTO cards VALUES(?,?,?,3,2,?,55)").run(cardID, customerID, importedCafe, "2026-01-02T03:04:05.000Z");
        const originalURL = "https://expired.example.test/tagtt?e=0011";
        legacy.db.prepare("INSERT INTO events VALUES(55,?,?,?,?,?,?,77)").run(eventID, customerID, requestID, digest(originalURL), cardID, uid);
        legacy.db.prepare("INSERT INTO wallet_passes VALUES(?,?,?,55,123,?)").run(cardID, token, revision, "https://old.example.test");
        legacy.db.prepare("INSERT INTO wallet_devices VALUES(?,?)").run("imported-device", "a".repeat(64));
        legacy.db.prepare("INSERT INTO wallet_registrations VALUES(?,?)").run("imported-device", cardID);
        legacy.db.prepare("INSERT INTO wallet_jobs VALUES(?,99,3,1234567)").run("imported-device");
        const passDirectory = join(directory, "passes", cardID, revision);
        await mkdir(passDirectory, { recursive: true });
        legacy.close();
        legacyClosed = true;
        await assert.rejects(importNative(target.pool, { source: sourcePath }), /ENOENT/);
        assert.equal((await target.pool.query("SELECT 1 FROM native_customers")).rowCount, 0, "missing pass bytes roll back all earlier inserts");
        await writeFile(join(passDirectory, "pass.pkpass"), "original-signed-fixture");
        const inconsistent = new DatabaseSync(sourcePath);
        inconsistent.prepare("UPDATE tags SET last_counter=76").run();
        inconsistent.close();
        await assert.rejects(importNative(target.pool, { source: sourcePath }), /inconsistent/);
        assert.equal((await target.pool.query("SELECT 1 FROM native_events")).rowCount, 0);
        const repaired = new DatabaseSync(sourcePath);
        repaired.prepare("UPDATE tags SET last_counter=77").run();
        repaired.close();
        const dry = await importNative(target.pool, { source: sourcePath, role: process.env.PGUSER });
        assert.equal(dry.applied, false);
        assert.equal(dry.counts.events, 1);
        assert.equal((await target.pool.query("SELECT 1 FROM native_customers")).rowCount, 0);
        const applied = await importNative(target.pool, { source: sourcePath, apply: true });
        assert.equal(applied.applied, true);
        const importedStore = new NativeStore(target.pool);
        assert.equal((await importedStore.authenticate(`Bearer ${bearer}`)).id, customerID);
        assert.equal((await importedStore.login("imported-native", password)).username, fixture.username);
        const stored = (await target.pool.query("SELECT * FROM native_customers WHERE id=$1", [customerID])).rows[0];
        assert.equal(stored.is_prototype, false, "legacy customer imports never become anonymous technical accounts");
        assert.equal(stored.password_hash, sourceCustomer.password_hash);
        assert.equal(stored.salt, sourceCustomer.salt);
        assert.equal((await target.pool.query("SELECT expires FROM native_sessions WHERE hash=$1", [digest(bearer)])).rows[0].expires, String(expires));
        assert.equal((await importedStore.previous(customerID, requestID, originalURL))?.id, eventID);
        assert.equal((await importedStore.card(cardID)).rewardsAvailable, 2);
        const importedWallet = new NativeWallet(importedStore, { ...services.wallet.options, baseURL: "https://old.example.test" });
        const authorized = await importedWallet.authorize(`ApplePass ${token}`, passType, cardID);
        assert.equal(authorized.bytes?.toString(), "original-signed-fixture");
        assert.equal((await importedWallet.publish(cardID)).token, token);
        assert.equal((await importedWallet.changes("imported-device", passType, undefined))?.lastUpdated, "55");
        assert.equal((await target.pool.query("SELECT generation,attempts,next_attempt FROM native_wallet_jobs")).rows[0].attempts, 3);
        assert.equal((await target.pool.query("SELECT generation FROM native_wallet_jobs")).rows[0].generation, "99");
        assert.equal((await target.pool.query("SELECT next_attempt FROM native_wallet_jobs")).rows[0].next_attempt, "1234567");
        await assert.rejects(importedStore.award(customerID, randomUUID(), "fixture", { uid, counter: 77 }), { status: 409 });
        const next = await importedStore.award(customerID, randomUUID(), "fixture-next", { uid, counter: 78 });
        assert.equal(next.card.stamps, 1);
        assert.equal(next.card.rewardsAvailable, 2);
        assert.ok(BigInt(next.card.version) > 55n);
        const renewed = await importedWallet.publish(cardID);
        assert.equal(renewed.token, token);
        assert.ok(BigInt(renewed.change_tag) > 55n);
        await assert.rejects(importNative(target.pool, { source: sourcePath, apply: true }), /empty compatibility domain/);
        assert.equal((await target.pool.query("SELECT last_counter FROM native_tags")).rows[0].last_counter, 78);
    } finally {
        if (!legacyClosed) legacy.close();
        await target.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("real signing/configuration and enabled server startup, native HTTP, durable pkpass download and graceful shutdown", async () => {
    const directory = await mkdtemp(resolve(".dev/native-signing-test-"));
    const rootKey = join(directory, "root-key.pem"), rootCert = join(directory, "root.pem");
    const key = join(directory, "signer-key.pem"), cert = join(directory, "signer.pem"), csr = join(directory, "signer.csr");
    const openssl = (args: string[]) => {
        const result = spawnSync("openssl", args, { stdio: "pipe" });
        assert.equal(result.status, 0, "Fixture OpenSSL operation failed (no certificate/key contents logged)");
    };
    const verifier = createServer((_request, reply) => {
        reply.writeHead(200, { "content-type": "application/json" });
        reply.end(JSON.stringify({ uid, read_ctr: 50, enc_mode: "AES" }));
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
        // Generated test-only identities, never the existing external Apple identity.
        openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Native Fixture Root", "-keyout", rootKey, "-out", rootCert]);
        openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Native Fixture Signer", "-keyout", key, "-out", csr]);
        openssl(["x509", "-req", "-in", csr, "-CA", rootCert, "-CAkey", rootKey, "-set_serial", "2", "-days", "2", "-out", cert]);
        verifier.listen(0, "127.0.0.1");
        await once(verifier, "listening");
        const address = verifier.address();
        assert.ok(address && typeof address !== "string");
        const settings = {
            NATIVE_NFC_ENABLED: "1", NATIVE_PROTOTYPE_MODE: "1", PUBLIC_BASE_URL: "https://native.example.test",
            SDM_BACKEND_URL: `http://127.0.0.1:${address.port}`,
            NATIVE_NFC_KEY_MODE: "factory-test", FACTORY_KEY_TEST: "1",
            PASS_TYPE_ID: passType, TEAM_ID: "TEAMTEST01",
            SIGNER_CERT_PATH: cert, SIGNER_KEY_PATH: key, WWDR_CERT_PATH: rootCert,
            SIGNER_KEY_PASSPHRASE: "",
        };
        const config = await nativeConfigFromEnv(settings);
        assert.ok(config);
        assert.equal(config.prototypeMode, true);
        assert.equal((await nativeConfigFromEnv({ ...settings, NATIVE_PROTOTYPE_MODE: "0" }))?.prototypeMode, false);
        await assert.rejects(nativeConfigFromEnv({ ...settings, SIGNER_KEY_PATH: rootKey }), /does not match/);
        // Render directly without relying on an already published fake pass.
        const fixtureCard = {
            id: randomUUID(), cafeId: cafeID, cafeName: "Hardware Test Cafe", stamps: 2,
            target: 3, rewardsAvailable: 1, updatedAt: new Date().toISOString(), version: "1",
        };
        const signed = await renderPass(fixtureCard, { ...config, token: "fixture-pass-token-not-a-real-credential" });
        assert.equal(signed.subarray(0, 2).toString(), "PK");
        const zipPath = join(directory, "fixture.pkpass");
        await writeFile(zipPath, signed);
        for (const filename of ["signature", "manifest.json"]) {
            const entry = spawnSync("unzip", ["-p", zipPath, filename], { stdio: "pipe" });
            assert.equal(entry.status, 0);
            await writeFile(join(directory, filename), entry.stdout);
        }
        openssl(["cms", "-verify", "-inform", "DER", "-in", join(directory, "signature"),
            "-content", join(directory, "manifest.json"), "-CAfile", rootCert, "-purpose", "any",
            "-out", join(directory, "verified-manifest.json")]);
        const schema = (await ctx.pool.query("SELECT current_schema() AS name")).rows[0].name;
        child = spawn(process.execPath, ["src/server.ts"], {
            cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env, ...settings, PGOPTIONS: `-c search_path=${schema}`,
                HOST: "127.0.0.1", PORT: "0", IMAGE_STORE: "local", IMAGE_CLEANUP: "off",
                NODE_ENV: "test",
                // The API issues its own tokens; "dev" signs with a throwaway key kept in .dev/ (git-ignored).
                AUTH_MODE: "dev",
            },
        });
        const runningChild = child;
        const origin = await new Promise<string>((done, reject) => {
            const timeout = setTimeout(() => reject(new Error("Fixture backend startup timed out.")), 15_000);
            runningChild.once("error", (error) => { clearTimeout(timeout); reject(error); });
            runningChild.once("exit", () => { clearTimeout(timeout); reject(new Error("Fixture backend exited before listening.")); });
            runningChild.stdout?.on("data", (chunk: Buffer) => {
                const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());
                if (match?.[1]) { clearTimeout(timeout); done(match[1]); }
            });
        });
        assert.equal((await (await fetch(`${origin}/healthz`)).json()).nativeNfc.enabled, true);
        assert.deepEqual(await (await fetch(`${origin}/api/v1/healthz`)).json(), {
            status: "ok", factoryKeyTest: true, publicBaseURL: settings.PUBLIC_BASE_URL, prototypeMode: true,
        });
        const guestSession = await fetch(`${origin}/api/v1/prototype/session`, { method: "POST" });
        assert.equal(guestSession.status, 200);
        const guest = await guestSession.json();
        assert.equal(guest.prototype, true);
        const guestCards = await fetch(`${origin}/api/v1/cards`, { headers: { authorization: `Bearer ${guest.token}` } });
        assert.deepEqual(await guestCards.json(), { cards: [] });
        const signup = await fetch(`${origin}/api/v1/accounts`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "running-native", password }),
        });
        assert.equal(signup.status, 201);
        const { token } = await signup.json();
        const response = await fetch(`${origin}/api/v1/taps`, {
            method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ url: "https://expired-host.example/tagtt?e=0011", requestId: randomUUID() }),
        });
        assert.equal(response.status, 200);
        const earned = await response.json();
        assert.equal(earned.card.stamps, 1);
        const downloaded = await fetch(`${origin}/api/v1/cards/${earned.card.id.toUpperCase()}/pass`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(downloaded.status, 200);
        assert.equal(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 2).toString(), "PK");
        const exit = once(runningChild, "exit");
        runningChild.kill("SIGTERM");
        const [code] = await exit;
        assert.equal(code, 0);
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            const exit = once(child, "exit");
            child.kill("SIGTERM");
            await exit;
        }
        if (verifier.listening) await new Promise<void>((done, reject) => verifier.close((error) => error ? reject(error) : done()));
        await rm(directory, { recursive: true, force: true });
    }
});
