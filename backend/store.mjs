import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { randomBytes, randomUUID, createHash, scrypt as derive, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./support.mjs";

const scrypt = promisify(derive);
const digest = (value) => createHash("sha256").update(value).digest("hex");
export class CustomerStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cafes(id TEXT PRIMARY KEY,name TEXT NOT NULL,target INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tags(uid TEXT PRIMARY KEY,cafe_id TEXT REFERENCES cafes(id),last_counter INTEGER NOT NULL DEFAULT -1);
      CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,customer_id TEXT REFERENCES customers(id),cafe_id TEXT REFERENCES cafes(id),
        stamps INTEGER NOT NULL,rewards INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(customer_id,cafe_id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,customer_id TEXT NOT NULL,
        request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,card_id TEXT NOT NULL,uid TEXT NOT NULL,counter INTEGER NOT NULL,
        UNIQUE(customer_id,request_id),UNIQUE(uid,counter));
    `);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  credentials(username, password) {
    if (typeof username !== "string" || !/^[a-zA-Z0-9._-]{3,40}$/.test(username) ||
        typeof password !== "string" || password.length < 12 || password.length > 128) {
      throw new HttpError(400, "Use a 3-40 character username (letters, numbers, . _ -) and a 12-128 character password.");
    }
    return username.toLowerCase();
  }
  async signup(username, password) {
    username = this.credentials(username, password);
    const salt = randomBytes(16).toString("hex");
    const hash = Buffer.from(await scrypt(password, salt, 64)).toString("hex");
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM customers WHERE username=?").get(username)) throw new HttpError(409, "That username is already taken.");
      const id = randomUUID();
      this.db.prepare("INSERT INTO customers VALUES(?,?,?,?)").run(id, username, salt, hash);
      return this.session(id, username);
    });
  }
  async login(username, password) {
    username = this.credentials(username, password);
    const customer = this.db.prepare("SELECT * FROM customers WHERE username=?").get(username);
    const hash = Buffer.from(await scrypt(password, customer?.salt ?? "unknown-account-salt", 64));
    const expected = customer ? Buffer.from(customer.password_hash, "hex") : Buffer.alloc(64);
    if (!timingSafeEqual(hash, expected) || !customer) throw new HttpError(401, "Incorrect username or password.");
    return this.session(customer.id, customer.username);
  }
  session(id, username) {
    const token = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(digest(token), id, Date.now() + 30 * 86400_000);
    return { token, username };
  }
  authenticate(header) {
    if (typeof header !== "string" || !/^Bearer [0-9a-f]{64}$/.test(header)) throw new HttpError(401, "Please sign in.");
    const hash = digest(header.slice(7));
    const customer = this.db.prepare(`SELECT c.id,c.username FROM sessions s JOIN customers c ON c.id=s.customer_id
      WHERE s.hash=? AND s.expires>?`).get(hash, Date.now());
    if (!customer) throw new HttpError(401, "Your session expired. Please sign in.");
    return { ...customer, sessionHash: hash };
  }
  seedCafe(name, target, tags) {
    if (!name?.trim() || !Number.isInteger(target) || target < 3 || target > 12) throw new Error("Invalid cafe configuration.");
    return this.transaction(() => {
      let cafe = this.db.prepare("SELECT * FROM cafes ORDER BY rowid LIMIT 1").get();
      if (!cafe) {
        const id = randomUUID();
        this.db.prepare("INSERT INTO cafes VALUES(?,?,?)").run(id, name.trim(), target);
        cafe = this.db.prepare("SELECT * FROM cafes WHERE id=?").get(id);
      }
      for (const { uid, lastCounter = -1 } of tags) {
        if (!/^[0-9A-F]{14}$/.test(uid) || !Number.isInteger(lastCounter) || lastCounter < -1 || lastCounter > 0xffffff) throw new Error("Invalid tag identity.");
        this.db.prepare("INSERT OR IGNORE INTO tags VALUES(?,?,?)").run(uid, cafe.id, lastCounter);
      }
      return cafe;
    });
  }
  card(id, customerId) {
    const row = this.db.prepare(`SELECT c.*,f.name AS cafe_name,f.target FROM cards c JOIN cafes f ON f.id=c.cafe_id
      WHERE c.id=? AND c.customer_id=?`).get(id, customerId);
    if (!row) throw new HttpError(404, "Card not found.");
    return { id: row.id, cafeId: row.cafe_id, cafeName: row.cafe_name, stamps: row.stamps,
      target: row.target, rewardsAvailable: row.rewards, updatedAt: row.updated_at, version: row.version };
  }
  cards(customerId) { return this.db.prepare("SELECT id FROM cards WHERE customer_id=? ORDER BY updated_at DESC").all(customerId).map(({ id }) => this.card(id, customerId)); }
  previous(customerId, requestId, url) {
    const previous = this.db.prepare("SELECT * FROM events WHERE customer_id=? AND request_id=?").get(customerId, requestId);
    if (previous && previous.fingerprint !== digest(url)) throw new HttpError(409, "This request ID was already used for a different tap.");
    return previous;
  }
  award(customerId, requestId, url, verified) {
    return this.transaction(() => {
      const existing = this.previous(customerId, requestId, url);
      if (existing) return { eventId: existing.id, card: this.card(existing.card_id, customerId), duplicate: true };
      const tag = this.db.prepare("SELECT * FROM tags WHERE uid=?").get(verified.uid);
      if (!tag) throw new HttpError(409, "This chip has not been linked to a cafe. Ask the operator to link it.");
      if (verified.counter <= tag.last_counter) throw new HttpError(409, "This tap link was already used. Scan the physical chip again.");
      let card = this.db.prepare("SELECT * FROM cards WHERE customer_id=? AND cafe_id=?").get(customerId, tag.cafe_id);
      if (!card) {
        const id = randomUUID();
        this.db.prepare("INSERT INTO cards(id,customer_id,cafe_id,stamps,updated_at) VALUES(?,?,?,0,?)").run(id, customerId, tag.cafe_id, new Date().toISOString());
        card = this.db.prepare("SELECT * FROM cards WHERE id=?").get(id);
      }
      const target = this.db.prepare("SELECT target FROM cafes WHERE id=?").get(tag.cafe_id).target;
      const stamps = card.stamps >= target ? 1 : card.stamps + 1;
      const rewards = card.rewards + (stamps === target ? 1 : 0);
      const id = randomUUID();
      const event = this.db.prepare("INSERT INTO events(id,customer_id,request_id,fingerprint,card_id,uid,counter) VALUES(?,?,?,?,?,?,?)")
        .run(id, customerId, requestId, digest(url), card.id, verified.uid, verified.counter);
      this.db.prepare("UPDATE tags SET last_counter=? WHERE uid=?").run(verified.counter, verified.uid);
      this.db.prepare("UPDATE cards SET stamps=?,rewards=?,updated_at=?,version=? WHERE id=?")
        .run(stamps, rewards, new Date().toISOString(), Number(event.lastInsertRowid), card.id);
      return { eventId: id, card: this.card(card.id, customerId), duplicate: false };
    });
  }
  close() { this.db.close(); }
}
