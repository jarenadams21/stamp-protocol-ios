import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { HttpError } from "../../support.mjs";
import { transaction } from "../db.ts";
import { NativeStore, normalizeUUID, type NativeCard } from "./store.ts";

export interface PassRow {
    serial: string;
    token: string;
    revision: string | null;
    version: string;
    modified: string;
    base_url: string | null;
    change_tag: string;
    bytes: Buffer | null;
}
export interface WalletOptions {
    baseURL: string;
    passType: string;
    render(card: NativeCard, token: string): Promise<Buffer>;
    sendPush(token: string): Promise<boolean>;
}
export class NativeWallet {
    readonly store: NativeStore;
    readonly options: WalletOptions;
    constructor(store: NativeStore, options: WalletOptions) { this.store = store; this.options = options; }

    async publish(serial: string): Promise<PassRow> {
        return transaction(this.store.pool, async (db) => {
            // Hold the card lock through signing: another worker must never publish an
            // older snapshot over a newer stamp, even across multiple server instances.
            const locked = await db.query("SELECT id FROM native_cards WHERE id=$1 FOR UPDATE", [normalizeUUID(serial)]);
            if (!locked.rowCount) throw new HttpError(404, "Card not found.");
            const card = await this.store.card(serial, undefined, db);
            await db.query("INSERT INTO native_wallet_passes(serial,token) VALUES($1,$2) ON CONFLICT DO NOTHING",
                [card.id, randomBytes(32).toString("hex")]);
            const { rows: [previous] } = await db.query<PassRow>("SELECT * FROM native_wallet_passes WHERE serial=$1", [card.id]);
            if (!previous) throw new Error("Missing Wallet pass");
            if (previous.version === card.version && previous.base_url === this.options.baseURL && previous.bytes) return previous;
            const bytes = await this.options.render(card, previous.token);
            if (!bytes.length) throw new Error("Empty Wallet pass");
            const modified = Math.max(Math.floor(Date.now() / 1000), Number(previous.modified) + 1);
            // Sequence allocation is not commit-ordered. Serialize publication through
            // COMMIT so a device cursor cannot skip an earlier uncommitted change.
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('joeyy.native-wallet.change-publication',0))");
            const { rows: [current] } = await db.query<PassRow>(
                `UPDATE native_wallet_passes SET revision=$1,version=$2,modified=$3,base_url=$4,
                 bytes=$5,change_tag=nextval('native_wallet_change_seq') WHERE serial=$6 RETURNING *`,
                [randomUUID(), card.version, modified, this.options.baseURL, bytes, card.id]);
            if (!current) throw new Error("Missing published Wallet pass");
            await db.query(
                `INSERT INTO native_wallet_jobs(device,generation)
                 SELECT device,1 FROM native_wallet_registrations WHERE serial=$1
                 ON CONFLICT(device) DO UPDATE SET generation=native_wallet_jobs.generation+1,attempts=0,next_attempt=0`, [card.id]);
            return current;
        });
    }

    async authorize(header: string | undefined, type: string, rawSerial: string) {
        const serial = normalizeUUID(rawSerial);
        const { rows: [pass] } = await this.store.pool.query<PassRow>("SELECT * FROM native_wallet_passes WHERE serial=$1", [serial]);
        const supplied = Buffer.from(header ?? ""), expected = Buffer.from(`ApplePass ${pass?.token ?? ""}`);
        if (type !== this.options.passType || !pass?.bytes || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            throw new HttpError(401, "Invalid pass authorization.");
        }
        return pass;
    }

    async register(device: string, serial: string, pushToken: string) {
        return transaction(this.store.pool, async (db) => {
            const { rows: [old] } = await db.query<{ push_token: string }>(
                "SELECT push_token FROM native_wallet_devices WHERE device=$1 FOR UPDATE", [device]);
            // ON CONFLICT also serializes first-time registrations for the same device.
            await db.query(
                `INSERT INTO native_wallet_devices(device,push_token) VALUES($1,$2)
                 ON CONFLICT(device) DO UPDATE SET push_token=excluded.push_token`, [device, pushToken]);
            const inserted = await db.query(
                "INSERT INTO native_wallet_registrations(device,serial) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING device", [device, serial]);
            if (inserted.rowCount || old?.push_token !== pushToken) {
                await db.query(
                    `INSERT INTO native_wallet_jobs(device,generation) VALUES($1,1)
                     ON CONFLICT(device) DO UPDATE SET generation=native_wallet_jobs.generation+1,attempts=0,next_attempt=0`, [device]);
            }
            return Boolean(inserted.rowCount);
        });
    }

    async unregister(device: string, serial: string) {
        await transaction(this.store.pool, async (db) => {
            await db.query("SELECT device FROM native_wallet_devices WHERE device=$1 FOR UPDATE", [device]);
            await db.query("DELETE FROM native_wallet_registrations WHERE device=$1 AND serial=$2", [device, serial]);
            await db.query(
                `DELETE FROM native_wallet_devices WHERE device=$1 AND NOT EXISTS
                 (SELECT 1 FROM native_wallet_registrations WHERE device=$1)`, [device]);
        });
    }

    async changes(device: string, type: string, since: string | undefined) {
        if (since !== undefined && !/^\d{1,15}$/.test(since)) throw new HttpError(400, "Invalid update tag.");
        if (type !== this.options.passType) return undefined;
        const { rows } = await this.store.pool.query<{ serial: string; change_tag: string }>(
            `SELECT p.serial,p.change_tag::text FROM native_wallet_passes p
             JOIN native_wallet_registrations r ON r.serial=p.serial
             WHERE r.device=$1 AND p.bytes IS NOT NULL AND p.change_tag>$2 ORDER BY p.change_tag,p.serial`, [device, since ?? "-1"]);
        return rows.length ? { serialNumbers: rows.map((row) => row.serial), lastUpdated: rows.at(-1)!.change_tag } : undefined;
    }

    async flush() {
        let failed = 0;
        // Jobs are durable and locked across APNs delivery. SKIP LOCKED allows multiple
        // instances without racing token rotation or deleting a newer generation.
        const { rows } = await this.store.pool.query<{ device: string }>(
            "SELECT device FROM native_wallet_jobs WHERE next_attempt<=$1 ORDER BY next_attempt LIMIT 50", [Date.now()]);
        for (const { device } of rows) {
            await transaction(this.store.pool, async (db) => {
                const { rows: [job] } = await db.query<{ generation: string; attempts: number; push_token: string }>(
                    `SELECT j.generation,j.attempts,d.push_token FROM native_wallet_jobs j
                     JOIN native_wallet_devices d ON d.device=j.device
                     WHERE j.device=$1 AND j.next_attempt<=$2 FOR UPDATE OF d,j SKIP LOCKED`, [device, Date.now()]);
                if (!job) return;
                let invalid: boolean;
                try {
                    invalid = await this.options.sendPush(job.push_token);
                } catch {
                    await db.query(
                        `UPDATE native_wallet_jobs SET attempts=attempts+1,next_attempt=$1 WHERE device=$2 AND generation=$3`,
                        [Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts, 7)), device, job.generation]);
                    failed++;
                    return;
                }
                if (invalid) {
                    await db.query("DELETE FROM native_wallet_devices WHERE device=$1 AND push_token=$2", [device, job.push_token]);
                } else {
                    await db.query("DELETE FROM native_wallet_jobs WHERE device=$1 AND generation=$2", [device, job.generation]);
                }
            });
        }
        return { failed };
    }

    async reconcile(onFailure: () => void) {
        const { rows } = await this.store.pool.query<{ id: string }>(
            `SELECT c.id FROM native_cards c LEFT JOIN native_wallet_passes p ON p.serial=c.id
             WHERE p.bytes IS NULL OR p.version<>c.version OR p.base_url IS DISTINCT FROM $1
             ORDER BY c.updated_at LIMIT 50`, [this.options.baseURL]);
        for (const { id } of rows) {
            try { await this.publish(id); }
            catch { onFailure(); }
        }
    }
}
