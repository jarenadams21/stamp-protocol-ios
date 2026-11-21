import type pg from "pg";
import { isImageKey, LocalImageStore, type ImageStore } from "./images.ts";

// Image cleanup (docs/backend-spec.md section 3.2) -----------------------------------------------
//
// An image is in use while a business's logo_key or any program version's cover_key points to it.
// Covers on older versions stay in use, because version history shows them. Everything else is
// deleted once it's older than the grace period: logos that were replaced, and uploads that were
// never saved (the apps upload first and attach the key in a second request).
//
// Deleting happens in two steps, so no file is ever forgotten:
//   1. Delete the unused images rows. The database refuses to delete a row that's in use (foreign
//      keys), and a trigger queues each deleted row's file in image_deletions. Rows deleted when a
//      business is deleted are queued the same way.
//   2. Delete each queued file from storage, then its queue row. A failure stays queued and is
//      retried on the next run.

export interface CleanupOptions {
    /** How long an upload attached to nothing is kept, so an app can upload and then save. */
    unusedForMs: number;
    /** The most images handled in each step of one run. */
    batchSize?: number;
    /** Lists what would be deleted, and deletes nothing. */
    dryRun?: boolean;
    log?: (fields: Record<string, unknown>, message: string) => void;
}

export interface CleanupResult {
    /** Another cleanup was already running against this database schema, so this one did nothing. */
    skipped: boolean;
    /** Keys of images no longer in use, removed in this run (or that would be, in a dry run). */
    unused: string[];
    /** Files deleted from storage. */
    deleted: number;
    /** Files that couldn't be deleted. They stay queued and are retried on the next run. */
    failed: number;
    /** Files still queued for deletion after this run. */
    pending: number;
}

const UNUSED = `
    i.created_at < $1
    AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.logo_key = i.storage_key)
    AND NOT EXISTS (SELECT 1 FROM program_versions v WHERE v.cover_key = i.storage_key)`;

/** One cleanup at a time per schema, even with several API instances or developers running. */
const LOCK = "hashtext('joeyy.image-cleanup'), hashtext(current_schema())";

export async function cleanUpImages(pool: pg.Pool, store: ImageStore, options: CleanupOptions): Promise<CleanupResult> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
        const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${LOCK}) AS locked`);
        if (!lock.rows[0]?.locked) return { skipped: true, unused: [], deleted: 0, failed: 0, pending: 0 };
        try {
            return await run(client, store, options);
        } finally {
            await client.query(`SELECT pg_advisory_unlock(${LOCK})`).catch((error: Error) => {
                // Closing the connection releases the lock instead.
                broken = error;
            });
        }
    } finally {
        client.release(broken);
    }
}

async function run(client: pg.PoolClient, store: ImageStore, options: CleanupOptions): Promise<CleanupResult> {
    const batchSize = options.batchSize ?? 200;
    const log = options.log ?? (() => {});
    const cutoff = new Date(Date.now() - options.unusedForMs);
    const pendingCount = async () =>
        (await client.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM image_deletions")).rows[0]!.count;

    const candidates = await client.query<{ id: string; storage_key: string }>(
        `SELECT i.id, i.storage_key FROM images i WHERE ${UNUSED} ORDER BY i.created_at LIMIT $2`,
        [cutoff, batchSize],
    );
    if (options.dryRun) {
        return { skipped: false, unused: candidates.rows.map((row) => row.storage_key), deleted: 0, failed: 0, pending: await pendingCount() };
    }

    // Step 1: delete unused rows one at a time, checking again that each is still unused.
    const unused: string[] = [];
    for (const row of candidates.rows) {
        try {
            const removed = await client.query(`DELETE FROM images i WHERE i.id = $2 AND ${UNUSED}`, [cutoff, row.id]);
            if (removed.rowCount === 1) unused.push(row.storage_key);
        } catch (error) {
            // 23503: a save attached it while this ran, so it's in use after all. Keep it.
            if ((error as { code?: string }).code !== "23503") throw error;
        }
    }

    // Step 2: delete queued files, oldest first.
    const queued = await client.query<{ storage_key: string }>(
        "SELECT storage_key FROM image_deletions ORDER BY queued_at LIMIT $1",
        [batchSize],
    );
    let deleted = 0;
    let failed = 0;
    for (const { storage_key: key } of queued.rows) {
        try {
            // Only names this API issues are ever deleted from storage.
            if (!isImageKey(key)) throw new Error("Not an image key; delete it by hand");
            await store.remove(key);
            await client.query("DELETE FROM image_deletions WHERE storage_key = $1", [key]);
            deleted += 1;
        } catch (error) {
            failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            await client.query("UPDATE image_deletions SET attempts = attempts + 1, last_error = $2 WHERE storage_key = $1", [
                key,
                message.slice(0, 500),
            ]);
            log({ key, err: message }, "image file could not be deleted; it will be retried");
        }
    }
    return { skipped: false, unused, deleted, failed, pending: await pendingCount() };
}

// Configuration and scheduling ------------------------------------------------------------------

/** IMAGE_UNUSED_HOURS: how long an upload attached to nothing is kept. 24 hours unless set. */
export function unusedForMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const hours = Number(env.IMAGE_UNUSED_HOURS ?? 24);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
        throw new Error("IMAGE_UNUSED_HOURS must be a whole number from 1 to 720");
    }
    return hours * 60 * 60 * 1000;
}

/**
 * Whether the API runs cleanup on a schedule. IMAGE_CLEANUP=on or off; unless set, it's on for
 * Azure and off for the local folder. Off for local avoids a developer's local store deleting rows
 * for files that actually live in Azure, if it's ever pointed at a shared database.
 */
export function imageCleanupFromEnv(env: NodeJS.ProcessEnv, store: ImageStore): { unusedForMs: number } | null {
    const mode = env.IMAGE_CLEANUP ?? (store instanceof LocalImageStore ? "off" : "on");
    if (mode === "off") return null;
    if (mode !== "on") throw new Error(`IMAGE_CLEANUP must be "on" or "off", not "${mode}"`);
    return { unusedForMs: unusedForMsFromEnv(env) };
}

export interface CleanupSchedule {
    /** Stops scheduling and waits for a run in progress to finish. */
    stop(): Promise<void>;
}

type Logger = {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
};

/** Runs cleanup a minute after start, then every `everyMs`. Timers never keep the process alive. */
export function scheduleImageCleanup(
    pool: pg.Pool,
    store: ImageStore,
    options: { unusedForMs: number; everyMs?: number; firstAfterMs?: number; log: Logger },
): CleanupSchedule {
    const { log } = options;
    const everyMs = options.everyMs ?? 60 * 60 * 1000;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<void> | undefined;

    const tick = () => {
        running = cleanUpImages(pool, store, { unusedForMs: options.unusedForMs, log: (fields, message) => log.warn(fields, message) })
            .then((result) => {
                if (result.skipped) return;
                if (result.unused.length > 0 || result.deleted > 0 || result.failed > 0) {
                    log.info(
                        { removed: result.unused.length, deleted: result.deleted, failed: result.failed, pending: result.pending },
                        "image cleanup",
                    );
                }
            })
            .catch((error: unknown) => log.error({ err: error }, "image cleanup failed"))
            .finally(() => {
                running = undefined;
                if (!stopped) timer = setTimeout(tick, everyMs).unref();
            });
    };
    timer = setTimeout(tick, options.firstAfterMs ?? 60 * 1000).unref();

    return {
        async stop() {
            stopped = true;
            clearTimeout(timer);
            await running;
        },
    };
}
