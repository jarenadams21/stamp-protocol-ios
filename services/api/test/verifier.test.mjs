import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { verifyTag } from "../support.mjs";

test("NFC adapter forwards original hex and rejects HTTP-200 signature errors", async () => {
  let body = { uid: "04DE5F1EACC040", read_ctr: 61, enc_mode: "AES" }, received;
  const server = createServer((req, res) => { received = req.url; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = "https://expired-host.example/tagtt?picc_data=ef963ff7828658a599f3041510671e88&cmac=94EED9EE65337086";
  try {
    assert.deepEqual(await verifyTag(base, raw), { uid: body.uid, counter: 61 });
    assert.match(received, /picc_data=ef963ff7828658a599f3041510671e88/);
    body = { error: "Bad signature" };
    await assert.rejects(verifyTag(base, raw), { status: 422 });
    body = { uid: "bad", read_ctr: -1, enc_mode: "AES" };
    await assert.rejects(verifyTag(base, raw), { status: 502 });
    await assert.rejects(verifyTag(base, raw + "&cmac=00"), { status: 400 });
    await assert.rejects(verifyTag(base, "http://insecure.example/tagtt?e=aa"), { status: 400 });
  } finally { await new Promise((resolve) => server.close(resolve)); }
  await assert.rejects(verifyTag(base, raw), { status: 503 });
});
