import { buildApp } from "./app.ts";
import { authFromEnv } from "./auth.ts";
import { createPool } from "./db.ts";
import { imageCleanupFromEnv, scheduleImageCleanup } from "./imageCleanup.ts";
import { imagesFromEnv } from "./images.ts";
import { pruneAuthRecords } from "./signIn.ts";

const pool = createPool();
const images = imagesFromEnv();
const cleanup = imageCleanupFromEnv(process.env, images);
const auth = await authFromEnv();
const trustProxy = process.env.TRUST_PROXY;
const app = buildApp({
    pool,
    auth: auth.signer.config,
    signIn: auth.signIn,
    // "true" trusts every proxy; otherwise a comma-separated list of proxy addresses or CIDRs.
    trustProxy: !trustProxy || trustProxy === "false" ? false : trustProxy === "true" ? true : trustProxy,
    images,
    logger: {
        level: process.env.LOG_LEVEL ?? "info",
        // Never log tokens (spec section 10).
        redact: ["req.headers.authorization"],
    },
});
app.log.info({ auth: auth.mode, issuer: auth.signer.config.issuer, sms: auth.signIn.sms.label }, "sign-in");

// Deletes expired refresh tokens and old phone-code rows, hourly.
const pruneAuth = setInterval(() => {
    pruneAuthRecords(pool).catch((error: unknown) => app.log.error({ err: error }, "sign-in cleanup failed"));
}, 3_600_000);
pruneAuth.unref();

// Deletes images nothing uses anymore, hourly (spec section 3.2).
const schedule = cleanup ? scheduleImageCleanup(pool, images, { ...cleanup, log: app.log }) : undefined;
app.log.info({ images: images.label, cleanup: cleanup ? "hourly" : "off" }, "image storage");

const shutdown = async () => {
    clearInterval(pruneAuth);
    await schedule?.stop();
    await app.close();
    await pool.end();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
