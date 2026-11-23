import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type pg from "pg";
import { createPool } from "./db.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));

/**
 * Applies every migration in db/migrations that is not yet recorded in schema_migrations, in file
 * name order, each in its own transaction. Each file records its own version (see 0001).
 *
 * `role`: run as this role (SET LOCAL ROLE) so the objects it creates share one owner. On Azure,
 * that is the server admin role, which the Entra admin is a member of.
 */
export async function migrate(pool: pg.Pool, options: { role?: string; log?: (line: string) => void } = {}) {
    const log = options.log ?? (() => {});
    const files = (await readdir(MIGRATIONS_DIR)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    const applied = new Set<string>();
    const exists = await pool.query<{ table: string | null }>("SELECT to_regclass('schema_migrations')::text AS table");
    if (exists.rows[0]?.table) {
        const rows = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
        for (const row of rows.rows) applied.add(row.version);
    }

    const ran: string[] = [];
    for (const file of files) {
        const version = path.basename(file, ".sql");
        if (applied.has(version)) continue;
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            if (options.role) await client.query(`SET LOCAL ROLE ${quoteIdentifier(options.role)}`);
            await client.query(sql);
            const recorded = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
            if (recorded.rowCount !== 1) throw new Error(`${file} must insert '${version}' into schema_migrations`);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw new Error(`Migration ${file} failed and was rolled back: ${(error as Error).message}`, { cause: error });
        } finally {
            client.release();
        }
        log(`applied ${version}`);
        ran.push(version);
    }
    if (ran.length === 0) log("database is up to date");
    return ran;
}

export function quoteIdentifier(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

/** True when this module is the script Node was started with (`node src/migrate.ts`), on any OS. */
export function isMainModule(moduleUrl: string, argv1: string | undefined): boolean {
    return argv1 !== undefined && moduleUrl === pathToFileURL(path.resolve(argv1)).href;
}

// CLI: npm run migrate
if (isMainModule(import.meta.url, process.argv[1])) {
    const pool = createPool(process.env, { max: 1 });
    try {
        await migrate(pool, { role: process.env.MIGRATION_ROLE || undefined, log: console.log });
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}
