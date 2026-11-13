import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { connect } from "node:http2";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PKPass } from "passkit-generator";
import sharp from "sharp";
import { HttpError, jsonBody } from "./support.mjs";

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
export class CustomerWallet {
  constructor({ store, dataDir, baseURL, passType, teamID, certificates, sendPush }) {
    Object.assign(this, { store, db: store.db, dataDir, baseURL, passType, teamID, certificates, sendPush });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_passes(serial TEXT PRIMARY KEY,token TEXT NOT NULL,revision TEXT,
        version INTEGER NOT NULL DEFAULT -1,modified INTEGER NOT NULL DEFAULT 0,base_url TEXT);
      CREATE TABLE IF NOT EXISTS wallet_devices(device TEXT PRIMARY KEY,push_token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wallet_registrations(device TEXT REFERENCES wallet_devices(device) ON DELETE CASCADE,
        serial TEXT REFERENCES wallet_passes(serial),PRIMARY KEY(device,serial));
      CREATE TABLE IF NOT EXISTS wallet_jobs(device TEXT PRIMARY KEY REFERENCES wallet_devices(device) ON DELETE CASCADE,
        generation INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0);
    `);
  }
  async publish(card) {
    this.db.prepare("INSERT OR IGNORE INTO wallet_passes(serial,token) VALUES(?,?)").run(card.id, randomBytes(32).toString("hex"));
    const previous = this.db.prepare("SELECT * FROM wallet_passes WHERE serial=?").get(card.id);
    if (previous.version === card.version && previous.base_url === this.baseURL && previous.revision) return;
    const settings = { webServiceURL: this.baseURL + "/wallet", authenticationToken: previous.token };
    const circles = Array.from({ length: card.target }, (_, index) => {
      const x = 25 + index % 6 * 63, y = 55 + Math.floor(index / 6) * 55;
      return `<circle cx="${x}" cy="${y}" r="16" fill="${index < card.stamps ? "#fff6df" : "none"}" stroke="#fff6df" stroke-width="2"/>`;
    }).join("");
    const strip = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1125" height="432" viewBox="0 0 400 144">
      <rect width="400" height="144" fill="#19394f"/><text x="12" y="20" font-size="13" fill="#fff6df">${escape(card.cafeName)}</text>${circles}</svg>`)).png().toBuffer();
    const icon = await sharp({ create: { width: 87, height: 87, channels: 3, background: "#19394f" } }).png().toBuffer();
    const pass = new PKPass({ "icon@3x.png": icon, "icon.png": await sharp(icon).resize(29, 29).toBuffer(),
      "icon@2x.png": await sharp(icon).resize(58, 58).toBuffer(), "strip@3x.png": strip,
      "strip@2x.png": await sharp(strip).resize(750, 288).toBuffer(), "strip.png": await sharp(strip).resize(375, 144).toBuffer()
    }, this.certificates, {
      formatVersion: 1, passTypeIdentifier: this.passType, teamIdentifier: this.teamID, serialNumber: card.id,
      organizationName: "Cafe Wallet Prototype", description: `${card.cafeName} loyalty test`,
      logoText: card.cafeName, backgroundColor: "rgb(25,57,79)", foregroundColor: "rgb(255,246,223)",
      labelColor: "rgb(255,246,223)", ...settings
    });
    pass.type = "storeCard";
    pass.headerFields.push({ key: "stamps", label: "STAMPS", value: `${card.stamps} / ${card.target}` });
    pass.auxiliaryFields.push({ key: "rewards", label: "REWARDS AVAILABLE", value: card.rewardsAvailable });
    pass.backFields.push({ key: "terms", label: "Prototype", value: "Cafe Wallet Prototype test pass. Not redeemable for real purchases." });
    pass.setBarcodes({ format: "PKBarcodeFormatQR", message: card.id, messageEncoding: "iso-8859-1" });
    const revision = randomUUID();
    const directory = join(this.dataDir, "passes", card.id, revision);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "pass.pkpass"), pass.getAsBuffer(), { mode: 0o600 });
    this.store.transaction(() => {
      const modified = Math.max(Math.floor(Date.now() / 1000), previous.modified + 1);
      this.db.prepare("UPDATE wallet_passes SET revision=?,version=?,modified=?,base_url=? WHERE serial=?")
        .run(revision, card.version, modified, this.baseURL, card.id);
      this.db.prepare(`INSERT INTO wallet_jobs(device,generation)
        SELECT device,? FROM wallet_registrations WHERE serial=?
        ON CONFLICT(device) DO UPDATE SET generation=wallet_jobs.generation+1,attempts=0,next_attempt=0`).run(card.version, card.id);
    });
  }
  row(serial) { return this.db.prepare("SELECT * FROM wallet_passes WHERE serial=?").get(serial); }
  async bytes(serial) {
    const pass = this.row(serial);
    if (!pass?.revision) throw new HttpError(503, "Wallet pass is not ready. Retry the request.");
    return readFile(join(this.dataDir, "passes", serial, pass.revision, "pass.pkpass"));
  }
  authorize(req, type, serial) {
    const row = this.row(serial);
    const supplied = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`ApplePass ${row?.token}`);
    if (type !== this.passType || !row?.revision || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new HttpError(401, "Invalid pass authorization.");
    }
    return row;
  }
  async handle(req, res, path, send) {
    const registration = /^\/wallet\/v1\/devices\/([^/]{1,200})\/registrations\/([^/]+)\/([0-9a-f-]{36})$/.exec(path.pathname);
    if (registration && ["POST", "DELETE"].includes(req.method)) {
      const [, device, type, serial] = registration;
      const pass = this.authorize(req, type, serial);
      if (req.method === "DELETE") {
        this.store.transaction(() => {
          this.db.prepare("DELETE FROM wallet_registrations WHERE device=? AND serial=?").run(device, serial);
          this.db.prepare("DELETE FROM wallet_devices WHERE device=? AND NOT EXISTS(SELECT 1 FROM wallet_registrations WHERE device=?)").run(device, device);
        });
        return send(200);
      }
      const body = await jsonBody(req);
      if (typeof body.pushToken !== "string" || !/^[0-9a-fA-F]{32,512}$/.test(body.pushToken)) throw new HttpError(400, "Invalid push token.");
      const existed = this.db.prepare("SELECT 1 FROM wallet_registrations WHERE device=? AND serial=?").get(device, serial);
      this.store.transaction(() => {
        const old = this.db.prepare("SELECT push_token FROM wallet_devices WHERE device=?").get(device);
        this.db.prepare("INSERT INTO wallet_devices VALUES(?,?) ON CONFLICT(device) DO UPDATE SET push_token=excluded.push_token").run(device, body.pushToken);
        this.db.prepare("INSERT OR IGNORE INTO wallet_registrations VALUES(?,?)").run(device, serial);
        if (!existed || old?.push_token !== body.pushToken) {
          this.db.prepare(`INSERT INTO wallet_jobs(device,generation) VALUES(?,?) ON CONFLICT(device)
            DO UPDATE SET generation=wallet_jobs.generation+1,attempts=0,next_attempt=0`).run(device, pass.version);
        }
      });
      return send(existed ? 200 : 201);
    }
    const changes = /^\/wallet\/v1\/devices\/([^/]{1,200})\/registrations\/([^/]+)$/.exec(path.pathname);
    if (changes && req.method === "GET") {
      if (changes[2] !== this.passType) return send(204);
      const since = path.searchParams.get("passesUpdatedSince");
      if (since !== null && !/^\d{1,15}$/.test(since)) throw new HttpError(400, "Invalid update tag.");
      const rows = this.db.prepare(`SELECT p.serial,p.version FROM wallet_passes p JOIN wallet_registrations r ON r.serial=p.serial
        WHERE r.device=? AND p.version>? ORDER BY p.version`).all(changes[1], Number(since ?? -1));
      return rows.length ? send(200, { serialNumbers: rows.map((row) => row.serial), lastUpdated: String(rows.at(-1).version) }) : send(204);
    }
    const download = /^\/wallet\/v1\/passes\/([^/]+)\/([0-9a-f-]{36})$/.exec(path.pathname);
    if (download && req.method === "GET") {
      const row = this.authorize(req, download[1], download[2]);
      const headers = { "Last-Modified": new Date(row.modified * 1000).toUTCString(), ETag: `"${row.revision}"` };
      if (req.headers["if-none-match"] !== undefined ? req.headers["if-none-match"] === headers.ETag :
          Date.parse(req.headers["if-modified-since"]) >= row.modified * 1000) return send(304, undefined, headers);
      return send(200, await this.bytes(download[2]), { ...headers, "Content-Type": "application/vnd.apple.pkpass" });
    }
    if (path.pathname === "/wallet/v1/log" && req.method === "POST") {
      const body = await jsonBody(req);
      if (!Array.isArray(body.logs) || body.logs.length > 100 || body.logs.some((value) => typeof value !== "string")) throw new HttpError(400, "Invalid diagnostics.");
      console.warn("Wallet reported diagnostics; device-supplied contents omitted.");
      return send(200);
    }
    throw new HttpError(404, "Wallet endpoint not found.");
  }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      const jobs = this.db.prepare(`SELECT j.*,d.push_token FROM wallet_jobs j JOIN wallet_devices d ON d.device=j.device
        WHERE next_attempt<=? LIMIT 50`).all(Date.now());
      for (const job of jobs) {
        let invalid;
        try { invalid = await this.sendPush(job.push_token); }
        catch {
          this.db.prepare("UPDATE wallet_jobs SET attempts=attempts+1,next_attempt=? WHERE device=? AND generation=?")
            .run(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts, 7)), job.device, job.generation);
          console.error("Wallet push failed; retained for retry. Check certificate and APNs connectivity.");
          continue;
        }
        if (invalid) this.db.prepare("DELETE FROM wallet_devices WHERE device=? AND push_token=?").run(job.device, job.push_token);
        else this.db.prepare(`DELETE FROM wallet_jobs WHERE device=? AND generation=? AND
          EXISTS(SELECT 1 FROM wallet_devices WHERE device=? AND push_token=?)`).run(job.device, job.generation, job.device, job.push_token);
      }
    } finally { this.busy = false; }
  }
}

export function applePush(certificates, passType) {
  return (token) => new Promise((resolve, reject) => {
    const client = connect("https://api.push.apple.com", {
      cert: Buffer.concat([certificates.signerCert, Buffer.from("\n"), certificates.wwdr]),
      key: certificates.signerKey, passphrase: certificates.signerKeyPassphrase
    });
    let finished = false;
    const timer = setTimeout(() => finish(new Error("APNs timeout.")), 10000);
    function finish(error, invalid) {
      if (finished) return;
      finished = true; clearTimeout(timer); client.destroy();
      if (error) reject(error); else resolve(invalid);
    }
    client.on("error", () => finish(new Error("APNs connection failed.")));
    client.on("close", () => { if (!finished) finish(new Error("APNs connection closed.")); });
    client.once("connect", () => {
      const request = client.request({ ":method": "POST", ":path": `/3/device/${token}`, "apns-topic": passType,
        "apns-priority": "5", "apns-expiration": "0", "content-type": "application/json" });
      let status, body = "";
      request.on("response", (headers) => { status = headers[":status"]; });
      request.on("data", (chunk) => { body += chunk; if (body.length > 4096) finish(new Error("Invalid APNs response.")); });
      request.on("error", () => finish(new Error("APNs request failed.")));
      request.on("end", () => {
        if (status === 200) return finish(null, false);
        let reason;
        try { reason = JSON.parse(body).reason; } catch { return finish(new Error("Invalid APNs response.")); }
        if (status === 410 || (status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(reason))) return finish(null, true);
        finish(new Error("APNs rejected the update."));
      });
      request.end("{}");
    });
  });
}
