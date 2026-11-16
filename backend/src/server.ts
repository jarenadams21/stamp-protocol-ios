import { buildApp } from "./app.ts";
import { authFromEnv } from "./auth.ts";
import { createPool } from "./db.ts";
import { imageCleanupFromEnv, scheduleImageCleanup } from "./imageCleanup.ts";
import { imagesFromEnv } from "./images.ts";

const pool = createPool();
const images = imagesFromEnv();
const cleanup = imageCleanupFromEnv(process.env, images);
const app = buildApp({
    pool,
    auth: await authFromEnv(),
    images,
    logger: {
        level: process.env.LOG_LEVEL ?? "info",
        // Never log tokens (spec section 10).
        redact: ["req.headers.authorization"],
    },
});

// Deletes images nothing uses anymore, hourly (spec section 3.2).
const schedule = cleanup ? scheduleImageCleanup(pool, images, { ...cleanup, log: app.log }) : undefined;
app.log.info({ images: images.label, cleanup: cleanup ? "hourly" : "off" }, "image storage");

const shutdown = async () => {
    await schedule?.stop();
    await app.close();
    await pool.end();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
