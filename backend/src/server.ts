import { buildApp } from "./app.ts";
import { authFromEnv } from "./auth.ts";
import { createPool } from "./db.ts";
import { imageCleanupFromEnv, scheduleImageCleanup } from "./imageCleanup.ts";
import { imagesFromEnv } from "./images.ts";
import { nativeConfigFromEnv } from "./native/config.ts";
import { assertNativeReady, createNativeServices, scheduleNativeWorker } from "./native/index.ts";

// Validate the opt-in configuration before creating a pool or opening the listener.
const nativeConfig = await nativeConfigFromEnv();
const pool = createPool();
const images = imagesFromEnv();
const cleanup = imageCleanupFromEnv(process.env, images);
if (nativeConfig) await assertNativeReady(pool);
const native = nativeConfig ? createNativeServices(pool, nativeConfig) : undefined;
const app = buildApp({
    pool,
    auth: await authFromEnv(),
    images,
    native,
    logger: {
        level: process.env.LOG_LEVEL ?? "info",
        // Never log tokens (spec section 10).
        redact: ["req.headers.authorization"],
    },
});

// Deletes images nothing uses anymore, hourly (spec section 3.2).
const schedule = cleanup ? scheduleImageCleanup(pool, images, { ...cleanup, log: app.log }) : undefined;
const nativeSchedule = native ? scheduleNativeWorker(native, app.log) : undefined;
app.log.info({ images: images.label, cleanup: cleanup ? "hourly" : "off" }, "image storage");

let stopping: Promise<void> | undefined;
const shutdown = () => {
    stopping ??= (async () => {
        await schedule?.stop();
        await nativeSchedule?.stop();
        await app.close();
        await pool.end();
    })();
    return stopping;
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
