import { buildApp } from "./app.ts";
import { authFromEnv } from "./auth.ts";
import { createPool } from "./db.ts";
import { imageCleanupFromEnv, scheduleImageCleanup } from "./imageCleanup.ts";
import { imagesFromEnv } from "./images.ts";
import { nativeConfigFromEnv } from "./native/config.ts";
import { assertNativeReady, createNativeServices, scheduleNativeWorker } from "./native/index.ts";
import { pruneAuthRecords } from "./signIn.ts";
import { tagsFromEnv } from "./tags.ts";

// Validate the opt-in configuration before creating a pool or opening the listener.
const nativeConfig = await nativeConfigFromEnv();
const pool = createPool();
const images = imagesFromEnv();
const cleanup = imageCleanupFromEnv(process.env, images);
const auth = await authFromEnv();
const tags = tagsFromEnv();
const trustProxy = process.env.TRUST_PROXY;
if (nativeConfig) await assertNativeReady(pool);
const native = nativeConfig ? createNativeServices(pool, nativeConfig) : undefined;
const app = buildApp({
    pool,
    auth: auth.signer.config,
    signIn: auth.signIn,
    // "true" trusts every proxy; otherwise a comma-separated list of proxy addresses or CIDRs.
    trustProxy: !trustProxy || trustProxy === "false" ? false : trustProxy === "true" ? true : trustProxy,
    images,
    tags,
    // The website's origins, comma-separated (for example https://joeyy.app). Unset: no CORS.
    webOrigins: (process.env.WEB_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
    // AUTH_MODE=dev runs on plain http://localhost, where browsers drop Secure cookies.
    secureCookie: auth.mode !== "dev",
    devRoutes: auth.mode === "dev",
    native,
    logger: {
        level: process.env.LOG_LEVEL ?? "info",
        // Never log tokens (spec section 10).
        redact: ["req.headers.authorization"],
    },
});
app.log.info(
    { auth: auth.mode, issuer: auth.signer.config.issuer, methods: auth.signIn.methods, sms: auth.signIn.sms.label, email: auth.signIn.email.label },
    "sign-in",
);
app.log.info({ tags: tags.mode, devRoutes: auth.mode === "dev" }, "stand taps");

// Deletes expired refresh tokens and old phone-code rows, hourly.
const pruneAuth = setInterval(() => {
    pruneAuthRecords(pool).catch((error: unknown) => app.log.error({ err: error }, "sign-in cleanup failed"));
}, 3_600_000);
pruneAuth.unref();

// Deletes images nothing uses anymore, hourly (spec section 3.2).
const schedule = cleanup ? scheduleImageCleanup(pool, images, { ...cleanup, log: app.log }) : undefined;
const nativeSchedule = native ? scheduleNativeWorker(native, app.log) : undefined;
app.log.info({ images: images.label, cleanup: cleanup ? "hourly" : "off" }, "image storage");

let stopping: Promise<void> | undefined;
const shutdown = () => {
    stopping ??= (async () => {
        clearInterval(pruneAuth);
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
