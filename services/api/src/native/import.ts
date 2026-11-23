import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type pg from "pg";
import { quoteIdentifier } from "../migrate.ts";
import { normalizeUUID } from "./store.ts";
import { snapshotLegacySource } from "./snapshot.ts";

const tables = [
    { source: "customers", columns: ["id", "username", "salt", "password_hash"] },
    { source: "sessions", columns: ["hash", "customer_id", "expires"] },
    { source: "cafes", columns: ["id", "name", "target"] },
    { source: "tags", columns: ["uid", "cafe_id", "last_counter"] },
    { source: "cards", columns: ["id", "customer_id", "cafe_id", "stamps", "rewards", "updated_at", "version"] },
    { source: "events", columns: ["seq", "id", "customer_id", "request_id", "fingerprint", "card_id", "uid", "counter"] },
    { source: "wallet_passes", columns: ["serial", "token", "revision", "version", "modified", "base_url"] },
    { source: "wallet_devices", columns: ["device", "push_token"] },
    { source: "wallet_registrations", columns: ["device", "serial"] },
    { source: "wallet_jobs", columns: ["device", "generation", "attempts", "next_attempt"] },
] as const;
export interface ImportOptions {
    source: string;
    passesDir?: string;
    apply?: boolean;
    role?: string;
}
type Row = Record<string, SQLOutputValue>;
function text(row: Row, field: string) {
    const value = row[field];
    if (typeof value !== "string") throw new Error("Invalid legacy source field.");
    return value;
}
function integer(row: Row, field: string) {
    const value = row[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Invalid legacy source integer.");
    return value;
}
/**
 * Import into an EMPTY compatibility domain only. Reading the stopped legacy database in
 * one SQLite snapshot and inserting everything under PostgreSQL table locks avoids partial
 * cutovers. A dry-run exercises the same constraints and file reads, then rolls back.
 */
export async function importNative(pool: pg.Pool, options: ImportOptions) {
    const sourcePath = resolve(options.source);
    const snapshot = await snapshotLegacySource(sourcePath);
    let source: DatabaseSync | undefined;
    let client: pg.PoolClient | undefined;
    const counts: Record<string, number> = {};
    let begun = false;
    try {
        source = new DatabaseSync(snapshot.path, { readOnly: true });
        client = await pool.connect();
        source.exec("PRAGMA query_only=ON; BEGIN");
        if (source.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
            source.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Legacy source integrity check failed.");
        await client.query("BEGIN");
        begun = true;
        if (options.role) await client.query(`SET LOCAL ROLE ${quoteIdentifier(options.role)}`);
        const targetNames = tables.map(({ source: name }) => quoteIdentifier(`native_${name}`));
        await client.query(`LOCK TABLE ${targetNames.join(",")} IN ACCESS EXCLUSIVE MODE`);
        for (const name of targetNames) {
            if ((await client.query(`SELECT 1 FROM ${name} LIMIT 1`)).rowCount) {
                throw new Error("Native import requires an empty compatibility domain; refusing conflicts or overwrite.");
            }
        }
        const available = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
        const walletTableCount = tables.filter(({ source: name }) => name.startsWith("wallet_") && available.has(name)).length;
        if (walletTableCount !== 0 && walletTableCount !== 4) throw new Error("Legacy Wallet schema is incomplete.");
        for (const { source: name, columns } of tables) {
            if (!available.has(name) && name.startsWith("wallet_")) { counts[name] = 0; continue; }
            const rows = source.prepare(`SELECT ${columns.map(quoteIdentifier).join(",")} FROM ${quoteIdentifier(name)}`).all();
            counts[name] = rows.length;
            for (const row of rows) {
                const values: (SQLOutputValue | Buffer)[] = columns.map((column) => {
                    const value = row[column];
                    if (value === undefined) throw new Error("Missing legacy source field.");
                    if (["id", "customer_id", "cafe_id", "card_id", "request_id", "serial", "revision"].includes(column) && value !== null) {
                        return normalizeUUID(text(row, column));
                    }
                    return value;
                });
                const targetColumns: string[] = [...columns];
                if (name === "wallet_passes") {
                    const revision = row.revision;
                    const version = integer(row, "version");
                    targetColumns.push("change_tag", "bytes");
                    let bytes: Buffer | null = null;
                    if (revision !== null) {
                        // Validate source path components before reading private pass bytes.
                        const serial = normalizeUUID(text(row, "serial"));
                        const normalizedRevision = normalizeUUID(text(row, "revision"));
                        bytes = await readFile(join(resolve(options.passesDir ?? join(dirname(sourcePath), "passes")), serial, normalizedRevision, "pass.pkpass"));
                        if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Invalid legacy pass file size.");
                    }
                    values.push(Math.max(0, version), bytes);
                }
                const params = values.map((_, index) => `$${index + 1}`).join(",");
                await client.query(`INSERT INTO ${quoteIdentifier(`native_${name}`)} (${targetColumns.map(quoteIdentifier).join(",")}) VALUES(${params})`, values);
            }
        }
        // Cross-table invariants absent from the legacy SQLite schema must also hold.
        const invalid = await client.query(
            `SELECT 1 FROM native_cards c JOIN native_cafes f ON f.id=c.cafe_id WHERE c.stamps>f.target
             UNION ALL
             SELECT 1 FROM native_events e JOIN native_cards c ON c.id=e.card_id
             JOIN native_tags t ON t.uid=e.uid WHERE e.customer_id<>c.customer_id OR t.cafe_id<>c.cafe_id OR e.counter>t.last_counter
             UNION ALL
             SELECT 1 FROM native_cards c WHERE c.version<COALESCE((SELECT max(e.seq) FROM native_events e WHERE e.card_id=c.id),0)
             UNION ALL
             SELECT 1 FROM native_wallet_passes p JOIN native_cards c ON c.id=p.serial WHERE p.version>c.version
             LIMIT 1`);
        if (invalid.rowCount) throw new Error("Legacy source state is inconsistent; refusing an unsafe import.");
        // ALTER SEQUENCE ... RESTART is transactional (unlike setval). Account for
        // gaps and old update tags, so the first post-cutover event/change is newer.
        const { rows: [high] } = await client.query<{ event: string; change: string }>(
            `SELECT greatest(COALESCE((SELECT max(seq) FROM native_events),0),COALESCE((SELECT max(version) FROM native_cards),0))+1 AS event,
                    greatest(COALESCE((SELECT max(change_tag) FROM native_wallet_passes),0),COALESCE((SELECT max(version) FROM native_cards),0))+1 AS change`);
        if (!high || !/^\d+$/.test(high.event) || !/^\d+$/.test(high.change)) throw new Error("Invalid imported sequence state.");
        await client.query(`ALTER SEQUENCE native_events_seq_seq RESTART WITH ${high.event}`);
        await client.query(`ALTER SEQUENCE native_wallet_change_seq RESTART WITH ${high.change}`);
        await client.query(options.apply ? "COMMIT" : "ROLLBACK");
        begun = false;
        return { applied: options.apply === true, counts };
    } finally {
        try {
            if (begun) await client?.query("ROLLBACK");
        } finally {
            client?.release();
            try { source?.close(); }
            finally { await snapshot.remove(); }
        }
    }
}
