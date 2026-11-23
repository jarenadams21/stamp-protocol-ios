import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CustomerStore } from "../store.mjs";

test("customer sessions, balances, request IDs, and chip high-water marks survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joeyy-store-test-"));
  const path = join(directory, "store.sqlite");
  let store = new CustomerStore(path);
  try {
    const uid = "04DE5F1EACC040";
    store.seedCafe("Test cafe", 10, [{ uid, lastCounter: 5 }]);
    const account = await store.signup("FixtureUser", "Long-test-password");
    const customer = store.authenticate(`Bearer ${account.token}`);
    const requestId = randomUUID(), url = "https://example.test/tagtt?e=public-test-fixture";
    const awarded = store.award(customer.id, requestId, url, { uid, counter: 6 });
    store.close();
    store = new CustomerStore(path);
    assert.equal(store.authenticate(`Bearer ${account.token}`).id, customer.id);
    assert.equal(store.cards(customer.id)[0].stamps, 1);
    assert.equal(store.previous(customer.id, requestId, url).id, awarded.eventId);
    assert.throws(() => store.award(customer.id, randomUUID(), url, { uid, counter: 6 }), { status: 409 });
    store.seedCafe("Ignored replacement", 10, [{ uid, lastCounter: -1 }]);
    assert.equal(store.db.prepare("SELECT last_counter FROM tags WHERE uid=?").get(uid).last_counter, 6);
    assert.equal((await store.login("fixtureuser", "Long-test-password")).username, "fixtureuser");
    const stored = store.db.prepare("SELECT password_hash FROM customers WHERE id=?").get(customer.id);
    assert.notEqual(stored.password_hash, "Long-test-password");
    assert.equal(store.db.prepare("SELECT 1 FROM sessions WHERE hash=?").get(account.token), undefined, "sessions contain hashes, not bearer tokens");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
