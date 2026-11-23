import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { CustomerStore } from "../store.mjs";
import { customerAPI } from "../api.mjs";
import { HttpError } from "../support.mjs";

test("authenticated customers have separate cards, global chip replay protection, rollover, and retry-safe awards", async () => {
  const store = new CustomerStore(":memory:");
  const uid = "04DE5F1EACC040";
  store.seedCafe("Test Cafe", 3, [{ uid }]);
  let broken = false, verified = 0;
  const wallet = {
    publish: async () => { if (broken) throw new Error("Signing unavailable"); },
    bytes: async () => Buffer.from("signed-pass-test")
  };
  const server = createServer(customerAPI({
    store, wallet, verify: async (url) => {
      verified++;
      const value = new URL(url).searchParams.get("testCounter");
      if (value === "invalid") throw new HttpError(422, "Invalid signature.");
      return { uid, counter: Number(value) };
    }
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = (path, method = "GET", token, body) => fetch(base + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const tap = (counter, requestId = randomUUID()) => ({ url: `https://old-host.example/tagtt?testCounter=${counter}`, requestId });
  try {
    assert.equal((await call("/cards")).status, 401);
    assert.equal((await call("/accounts", "POST", null, { username: "test-a", password: "short" })).status, 400);
    const first = await call("/accounts", "POST", null, { username: "test-a", password: "A-long-fixture-password" });
    assert.equal(first.status, 201);
    const a = await first.json();
    const second = await call("/accounts", "POST", null, { username: "test-b", password: "Another-long-password" });
    const b = await second.json();
    assert.equal((await call("/sessions", "POST", null, { username: "test-a", password: "Wrong-password-long" })).status, 401);
    assert.equal((await call("/sessions", "POST", null, { username: "test-a", password: "A-long-fixture-password" })).status, 200);
    assert.deepEqual((await (await call("/cards", "GET", a.token)).json()).cards, []);
    const body = tap(1);
    const earned = await (await call("/taps", "POST", a.token, body)).json();
    assert.equal(earned.card.stamps, 1);
    assert.equal(earned.card.version, undefined);
    assert.equal(earned.card.rewardsAvailable, 0);
    assert.equal((await call(`/cards/${earned.card.id}/pass`, "GET", b.token)).status, 404);
    assert.equal((await call(`/cards/${earned.card.id}/pass`, "GET", a.token)).status, 200);
    assert.equal((await call(`/cards/${earned.card.id.toUpperCase()}/pass`, "GET", a.token)).status, 200, "Swift UUID.uuidString uses uppercase");
    assert.equal((await call(`/cards/${earned.card.id.toUpperCase()}/pass`, "GET", b.token)).status, 404);
    const retry = await (await call("/taps", "POST", a.token, body)).json();
    assert.equal(retry.duplicate, true);
    assert.equal(retry.eventId, earned.eventId);
    assert.equal(retry.card.stamps, 1);
    assert.equal(verified, 1, "same request retry does not resubmit a consumed SUN message");
    assert.equal((await call("/taps", "POST", a.token, tap(1))).status, 409);
    assert.equal((await call("/taps", "POST", b.token, tap(1))).status, 409, "counter is global, not per account");
    const own = await (await call("/taps", "POST", b.token, tap(2))).json();
    assert.notEqual(own.card.id, earned.card.id);
    assert.equal(own.card.stamps, 1);
    assert.equal((await call("/taps", "POST", a.token, tap(3, body.requestId))).status, 409);
    assert.equal((await call("/taps", "POST", a.token, tap("invalid"))).status, 422);
    assert.equal(store.db.prepare("SELECT last_counter FROM tags WHERE uid=?").get(uid).last_counter, 2);
    await call("/taps", "POST", a.token, tap(3));
    const full = await (await call("/taps", "POST", a.token, tap(4))).json();
    assert.equal(full.card.stamps, 3); assert.equal(full.card.rewardsAvailable, 1);
    const next = await (await call("/taps", "POST", a.token, tap(5))).json();
    assert.equal(next.card.stamps, 1); assert.equal(next.card.rewardsAvailable, 1);
    assert.equal(next.card.id, earned.card.id, "Wallet identity remains stable across rollover");
    broken = true;
    const interrupted = tap(6);
    assert.equal((await call("/taps", "POST", a.token, interrupted)).status, 503);
    broken = false;
    const recovered = await (await call("/taps", "POST", a.token, interrupted)).json();
    assert.equal(recovered.duplicate, true);
    assert.equal(recovered.card.stamps, 2);
    const simultaneous = tap(7);
    const responses = await Promise.all([call("/taps", "POST", a.token, simultaneous), call("/taps", "POST", a.token, simultaneous)]);
    const results = await Promise.all(responses.map((response) => response.json()));
    assert.equal(results[0].eventId, results[1].eventId);
    assert.equal(results[0].card.stamps, 3);
    assert.equal((await call("/session", "DELETE", a.token)).status, 204);
    assert.equal((await call("/cards", "GET", a.token)).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve)); store.close();
  }
});
