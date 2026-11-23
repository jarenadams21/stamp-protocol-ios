import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { CustomerStore } from "../store.mjs";
import { CustomerWallet } from "../wallet.mjs";
import { importNative } from "../src/native/import.ts";
import { NativeStore } from "../src/native/store.ts";
import { setUp } from "./helpers.ts";

test("import includes uncheckpointed committed WAL without changing source database/WAL/SHM bytes", async () => {
    assert.ok(["127.0.0.1", "localhost"].includes(process.env.PGHOST ?? ""), "Native tests require explicitly configured local PostgreSQL.");
    const ctx = await setUp();
    const directory = await mkdtemp(resolve(".dev/native-wal-test-"));
    const path = join(directory, "customers.sqlite");
    const source = new CustomerStore(path);
    try {
        source.db.exec("PRAGMA wal_autocheckpoint=0");
        const uid = "04DE5F1EACC040";
        source.seedCafe("WAL hardware-test cafe", 3, [{ uid }]);
        const account = await source.signup("wal-preserved", "wal-fixture-password");
        const customer = source.authenticate(`Bearer ${account.token}`);
        const requestID = randomUUID(), url = "https://expired.example.test/tagtt?e=0011";
        const earned = source.award(customer.id, requestID, url, { uid, counter: 123 });
        new CustomerWallet({ store: source, dataDir: directory, baseURL: "https://old.example.test", passType: "pass.com.example.native" });
        const revision = randomUUID(), token = "a".repeat(64);
        source.db.prepare("INSERT INTO wallet_passes VALUES(?,?,?,?,?,?)")
            .run(earned.card.id, token, revision, earned.card.version, 123, "https://old.example.test");
        const passDirectory = join(directory, "passes", earned.card.id, revision);
        await mkdir(passDirectory, { recursive: true });
        await writeFile(join(passDirectory, "pass.pkpass"), "wal-signed-pass-fixture");
        assert.ok((await stat(`${path}-wal`)).size > 0);
        const paths = [path, `${path}-wal`, `${path}-shm`];
        const hashes = () => Promise.all(paths.map(async (file) => createHash("sha256").update(await readFile(file)).digest("hex")));
        const before = await hashes();
        await writeFile(`${path}-journal`, "pending-rollback-journal-fixture");
        await assert.rejects(importNative(ctx.pool, { source: path }), /pending rollback journal/);
        assert.equal((await ctx.pool.query("SELECT 1 FROM native_customers")).rowCount, 0);
        await rm(`${path}-journal`);
        const dry = await importNative(ctx.pool, { source: path });
        assert.equal(dry.applied, false);
        assert.equal(dry.counts.customers, 1);
        assert.equal(dry.counts.events, 1);
        assert.equal((await ctx.pool.query("SELECT 1 FROM native_customers")).rowCount, 0);
        assert.deepEqual(await hashes(), before, "dry-run never opens the original SQLite source or touches its shared-memory index");
        const applied = await importNative(ctx.pool, { source: path, apply: true });
        assert.equal(applied.applied, true);
        assert.deepEqual(await hashes(), before, "apply also leaves every source file byte-for-byte unchanged");
        const imported = new NativeStore(ctx.pool);
        const importedCustomer = await imported.authenticate(`Bearer ${account.token}`);
        assert.equal(importedCustomer.id, customer.id);
        assert.equal(importedCustomer.isPrototype, false);
        assert.equal((await imported.previous(customer.id, requestID, url))?.id, earned.eventId);
        assert.equal((await imported.card(earned.card.id)).stamps, 1);
        assert.equal((await ctx.pool.query("SELECT last_counter FROM native_tags")).rows[0].last_counter, 123);
        const pass = (await ctx.pool.query("SELECT token,bytes FROM native_wallet_passes")).rows[0];
        assert.equal(pass.token, token);
        assert.equal(pass.bytes.toString(), "wal-signed-pass-fixture");
        assert.deepEqual((await readdir(resolve(".dev"))).filter((name) => name.startsWith("native-import-snapshot-")), []);
    } finally {
        source.close();
        await ctx.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("account/session and three chip high-water marks import without cards/events or a pass directory", async () => {
    assert.ok(["127.0.0.1", "localhost"].includes(process.env.PGHOST ?? ""), "Native tests require explicitly configured local PostgreSQL.");
    const ctx = await setUp();
    const directory = await mkdtemp(resolve(".dev/native-empty-cards-test-"));
    const path = join(directory, "customers.sqlite");
    const source = new CustomerStore(path);
    let closed = false;
    try {
        const tags = [
            { uid: "04DE5F1EACC040", lastCounter: 123 },
            { uid: "04DE5F1EACC041", lastCounter: 456 },
            { uid: "04DE5F1EACC042", lastCounter: -1 },
        ];
        source.seedCafe("Account-only migration fixture", 3, tags);
        const account = await source.signup("existing-fixture", "existing-fixture-password");
        const customer = source.authenticate(`Bearer ${account.token}`);
        const credentials = source.db.prepare("SELECT salt,password_hash FROM customers").get();
        const session = source.db.prepare("SELECT hash,expires FROM sessions").get();
        assert.ok(credentials && session);
        new CustomerWallet({ store: source, dataDir: directory, baseURL: "https://old.example.test", passType: "pass.com.example.native" });
        source.close();
        closed = true;
        const dry = await importNative(ctx.pool, { source: path });
        assert.deepEqual(dry.counts, {
            customers: 1, sessions: 1, cafes: 1, tags: 3, cards: 0, events: 0,
            wallet_passes: 0, wallet_devices: 0, wallet_registrations: 0, wallet_jobs: 0,
        });
        assert.equal((await ctx.pool.query("SELECT 1 FROM native_customers")).rowCount, 0);
        await importNative(ctx.pool, { source: path, apply: true });
        const imported = new NativeStore(ctx.pool);
        assert.equal((await imported.authenticate(`Bearer ${account.token}`)).id, customer.id);
        assert.deepEqual((await ctx.pool.query("SELECT salt,password_hash FROM native_customers")).rows[0], { ...credentials });
        assert.deepEqual((await ctx.pool.query("SELECT hash,expires::text FROM native_sessions")).rows[0], { hash: session.hash, expires: String(session.expires) });
        assert.deepEqual(await imported.cards(customer.id), []);
        assert.deepEqual((await ctx.pool.query("SELECT uid,last_counter AS \"lastCounter\" FROM native_tags ORDER BY uid")).rows, tags);
        await assert.rejects(imported.award(customer.id, randomUUID(), "replayed-fixture", { uid: tags[1]!.uid, counter: 456 }), { status: 409 });
        assert.equal((await imported.login("existing-fixture", "existing-fixture-password")).username, account.username);
        const first = await imported.award(customer.id, randomUUID(), "fresh-fixture", { uid: tags[0]!.uid, counter: 124 });
        assert.equal(first.card.stamps, 1);
        assert.equal((await ctx.pool.query("SELECT last_counter FROM native_tags WHERE uid=$1", [tags[1]!.uid])).rows[0].last_counter, 456);
    } finally {
        if (!closed) source.close();
        await ctx.close();
        await rm(directory, { recursive: true, force: true });
    }
});
