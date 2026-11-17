import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function nativeServiceOrigin(value) {
    if (!URL.canParse(value)) throw new Error("Provide the native service's permanent HTTPS origin.");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.pathname !== "/" || url.hostname.endsWith(".invalid") ||
        url.hostname === "localhost" || url.hostname.endsWith(".local")) {
        throw new Error("Use a real HTTPS origin without credentials, a path, or query parameters.");
    }
    if (url.hostname === "trycloudflare.com" || url.hostname.endsWith(".trycloudflare.com")) {
        throw new Error("A disposable Cloudflare hostname must not be embedded in a TestFlight build.");
    }
    return url.origin;
}

export async function checkNativeService(value, request = fetch, { requirePrototype = false } = {}) {
    const origin = nativeServiceOrigin(value);
    const response = await request(`${origin}/api/v1/healthz`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Native NFC readiness failed (HTTP ${response.status}).`);
    const health = await response.json();
    if (health?.status !== "ok" || typeof health.factoryKeyTest !== "boolean") {
        throw new Error("The server did not confirm native NFC readiness; partner-only health is insufficient.");
    }
    if (health.publicBaseURL !== origin) {
        throw new Error("The server's PUBLIC_BASE_URL must match the app's HTTPS origin so Wallet can reach it.");
    }
    if (requirePrototype && health.prototypeMode !== true) {
        throw new Error("The server must explicitly enable NATIVE_PROTOTYPE_MODE=1 for a no-account prototype build.");
    }
    return { origin, factoryKeyTest: health.factoryKeyTest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const health = await checkNativeService(process.argv[2]);
        console.log(`Native NFC service ready. Factory-key hardware test: ${health.factoryKeyTest ? "yes" : "no"}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Native service readiness failed.");
        process.exitCode = 1;
    }
}
