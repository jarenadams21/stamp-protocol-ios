import { createPool } from "../src/db.ts";
import { importNative } from "../src/native/import.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const sourceIndex = args.indexOf("--source"), passesIndex = args.indexOf("--passes-dir");
const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
const passesDir = passesIndex >= 0 ? args[passesIndex + 1] : undefined;
const allowed = new Set(["--apply", "--source", "--passes-dir"]);
const values = new Set([sourceIndex + 1, passesIndex + 1].filter((index) => index > 0));
if (!source || args.some((arg, index) => !allowed.has(arg) && !values.has(index)) ||
    (passesIndex >= 0 && !passesDir) || source.startsWith("--") || passesDir?.startsWith("--")) {
    throw new Error("Usage: npm run native:import -- --source /private/path/customers.sqlite [--passes-dir /private/path/passes] [--apply]. Default: dry-run.");
}
const pool = createPool(process.env, { max: 1 });
try {
    const result = await importNative(pool, { source, passesDir, apply, role: process.env.MIGRATION_ROLE || undefined });
    console.log(JSON.stringify({ mode: result.applied ? "applied" : "dry-run (rolled back)", counts: result.counts }));
} catch {
    console.error("Native import failed; no data committed. Check source integrity, pass files, empty destination, migration and owner role.");
    process.exitCode = 1;
} finally { await pool.end(); }
