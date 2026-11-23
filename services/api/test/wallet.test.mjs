import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { CustomerStore } from "../store.mjs";
import { CustomerWallet } from "../wallet.mjs";
import { customerAPI } from "../api.mjs";

test("Wallet registrations, authenticated downloads, conditional updates and push retries persist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joeyy-wallet-test-"));
  const path = join(directory, "test.sqlite");
  let store = new CustomerStore(path);
  const passType = "pass.com.example.demo", serial = randomUUID(), revision = randomUUID(), token = "b".repeat(64);
  let pushResult = false, delivered = 0;
  const sendPush = async () => { delivered++; if (pushResult === "offline") throw new Error("Offline"); return pushResult; };
  let wallet = new CustomerWallet({ store, dataDir: directory, baseURL: "https://example.test", passType, sendPush });
  const server = createServer((req, res) => customerAPIHandler(req, res));
  let customerAPIHandler = customerAPI({ store, wallet, verify: async () => { throw new Error("Unused"); } });
  try {
    const modified = Math.floor(Date.now() / 1000);
    store.db.prepare("INSERT INTO wallet_passes VALUES(?,?,?,1,?,?)").run(serial, token, revision, modified, "https://example.test");
    const passDir = join(directory, "passes", serial, revision);
    await mkdir(passDir, { recursive: true }); await writeFile(join(passDir, "pass.pkpass"), "pass-fixture");
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/wallet/v1`;
    const registration = `/devices/device-one/registrations/${passType}/${serial}`;
    const headers = { Authorization: `ApplePass ${token}`, "Content-Type": "application/json" };
    const call = (path, method = "GET", auth = false, body) => fetch(base + path, { method,
      headers: auth ? headers : { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined
    });
    const pushToken = "a".repeat(64);
    assert.equal((await call(registration, "POST", false, { pushToken })).status, 401);
    assert.equal((await call(registration, "POST", true, { pushToken })).status, 201);
    await wallet.flush(); assert.equal(delivered, 1);
    assert.equal((await call(registration, "POST", true, { pushToken })).status, 200);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM wallet_jobs").get().count, 0,
      "unchanged registrations do not create an endless push loop");
    const changes = await (await call(`/devices/device-one/registrations/${passType}`)).json();
    assert.deepEqual(changes.serialNumbers, [serial]);
    assert.equal((await call(`/devices/device-one/registrations/${passType}?passesUpdatedSince=${changes.lastUpdated}`)).status, 204);
    assert.equal((await call(`/devices/another-device/registrations/${passType}`)).status, 204);
    assert.equal((await call(`/passes/${passType}/${serial}`)).status, 401);
    const download = await call(`/passes/${passType}/${serial}`, "GET", true);
    assert.equal(download.status, 200); assert.equal(await download.text(), "pass-fixture");
    assert.equal((await fetch(base + `/passes/${passType}/${serial}`, {
      headers: { ...headers, "If-Modified-Since": download.headers.get("last-modified") }
    })).status, 304);
    store.db.prepare("INSERT INTO wallet_jobs(device,generation) VALUES('device-one',2)").run();
    store.close();
    store = new CustomerStore(path);
    wallet = new CustomerWallet({ store, dataDir: directory, baseURL: "https://example.test", passType, sendPush });
    customerAPIHandler = customerAPI({ store, wallet, verify: async () => { throw new Error("Unused"); } });
    assert.equal(wallet.row(serial).token, token);
    pushResult = "offline"; await wallet.flush();
    assert.equal(store.db.prepare("SELECT attempts FROM wallet_jobs").get().attempts, 1);
    store.db.prepare("UPDATE wallet_jobs SET next_attempt=0").run();
    pushResult = true; await wallet.flush();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM wallet_registrations").get().count, 0);
    assert.equal((await call(registration, "POST", true, { pushToken })).status, 201);
    assert.equal((await call(registration, "DELETE", true)).status, 200);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM wallet_devices").get().count, 0);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    store.close(); await rm(directory, { recursive: true, force: true });
  }
});
