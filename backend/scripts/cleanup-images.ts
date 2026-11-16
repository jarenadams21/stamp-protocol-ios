// Deletes images nothing uses anymore, now, instead of waiting for the API's hourly run.
//   npm run images:cleanup                 delete them
//   npm run images:cleanup -- --dry-run    list what would be deleted, and delete nothing
// Uses the same settings as the API: PG* for the database, IMAGE_STORE and AZURE_STORAGE_* for
// storage, and IMAGE_UNUSED_HOURS for how long an upload attached to nothing is kept.
import { createPool } from "../src/db.ts";
import { cleanUpImages, unusedForMsFromEnv } from "../src/imageCleanup.ts";
import { imagesFromEnv } from "../src/images.ts";

const dryRun = process.argv.includes("--dry-run");
const store = imagesFromEnv();
const unusedForMs = unusedForMsFromEnv();
const pool = createPool(process.env, { max: 1 });

console.log(`Database: ${process.env.PGDATABASE} on ${process.env.PGHOST}`);
console.log(`Images:   ${store.label}`);
console.log(`Keeping uploads attached to nothing for ${unusedForMs / 3_600_000} hours${dryRun ? " (dry run)" : ""}\n`);

try {
    let total = { unused: 0, deleted: 0, failed: 0, pending: 0 };
    // A run handles a batch; keep going until nothing is left (a dry run lists one batch).
    for (;;) {
        const result = await cleanUpImages(pool, store, {
            unusedForMs,
            dryRun,
            log: (fields, message) => console.error(`  ${message}: ${fields.key} (${fields.err})`),
        });
        if (result.skipped) {
            console.log("Another cleanup is running right now. Try again in a minute.");
            process.exitCode = 1;
            break;
        }
        for (const key of result.unused) console.log(`  ${dryRun ? "would remove" : "removed"} ${key}`);
        total = {
            unused: total.unused + result.unused.length,
            deleted: total.deleted + result.deleted,
            failed: total.failed + result.failed,
            pending: result.pending,
        };
        const progressed = result.unused.length > 0 || result.deleted > 0;
        if (dryRun || !progressed || result.pending === result.failed) break;
    }
    console.log(
        dryRun
            ? `\n${total.unused} unused images; ${total.pending} files already queued for deletion.`
            : `\nRemoved ${total.unused} unused images; deleted ${total.deleted} files; ${total.failed} failed; ${total.pending} still queued.`,
    );
} catch (error) {
    // 42P01: a table is missing, so migration 0003_images hasn't been applied to this database.
    if ((error as { code?: string }).code !== "42P01") throw error;
    console.error("This database has no images tables yet. Run `npm run migrate` first.");
    process.exitCode = 1;
} finally {
    await pool.end();
}
