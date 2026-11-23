import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Checks that a domain tells Apple "the JOEYY app owns chip links here", which is what makes tapping an NFC chip
// open the app. Apple fetches /.well-known/apple-app-site-association from the domain and is strict about it:
// HTTPS, status 200, no redirects, and JSON that lists our app ID and the chip path.
export const APP_ID = "S23DT2V34P.com.joeyy.customer";
export const CHIP_PATH = "/tagtt";

export function tapLinkOrigin(value) {
    if (!URL.canParse(value)) throw new Error("Provide the chip domain's HTTPS origin, for example https://try.thejoeyy.site.");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("Use an HTTPS origin without credentials, a path, or query parameters.");
    }
    return url.origin;
}

/** True when an entry of `components` (or the older `paths`) matches the chip path. */
function matchesChipPath(entry, path) {
    if (typeof entry === "string") return entry === "*" || entry === path || entry === `${path}*` || entry === `${path}?*`;
    return entry && typeof entry === "object" && !entry.exclude && (entry["/"] === path || entry["/"] === `${path}*` || entry["/"] === "*");
}

/**
 * Returns { ok, problems, warnings }. `request` is fetch; it is a parameter so tests can fake the server.
 * A problem means iOS will not open the app from a chip tap. A warning means it should work but is not ideal.
 */
export async function checkTapLink(value, request = fetch, { appId = APP_ID, path = CHIP_PATH } = {}) {
    const origin = tapLinkOrigin(value);
    const problems = [], warnings = [];
    let response;
    try {
        response = await request(`${origin}/.well-known/apple-app-site-association`, {
            headers: { Accept: "application/json" },
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
        });
    } catch (error) {
        const why = error?.name === "TimeoutError" ? "it did not answer within 15 seconds" : (error?.cause?.code ?? error?.message ?? "unknown error");
        return { ok: false, origin, problems: [`Could not reach ${origin} over HTTPS (${why}).`], warnings };
    }
    if (response.status >= 300 && response.status < 400) {
        problems.push(`The file redirects (HTTP ${response.status}). Apple does not follow redirects; it must be served directly.`);
        return { ok: false, origin, problems, warnings };
    }
    if (response.status !== 200) {
        problems.push(`The file is not served (HTTP ${response.status}).`);
        return { ok: false, origin, problems, warnings };
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    let body;
    try { body = await response.json(); }
    catch {
        const hint = type === "text/html" ? " The server returned its normal web page for this address instead of the file." : "";
        problems.push(`The response is not valid JSON.${hint}`);
        return { ok: false, origin, problems, warnings };
    }
    if (type !== "application/json") {
        warnings.push(`Content-Type is "${type || "missing"}", not application/json. Apple usually accepts it, but set application/json to be safe.`);
    }
    const details = Array.isArray(body?.applinks?.details) ? body.applinks.details : [];
    const forApp = details.filter((detail) =>
        (Array.isArray(detail?.appIDs) && detail.appIDs.includes(appId)) || detail?.appID === appId);
    if (forApp.length === 0) {
        problems.push(`applinks.details does not list the app ID ${appId}.`);
    } else if (!forApp.some((detail) => [...(detail.components ?? []), ...(detail.paths ?? [])].some((entry) => matchesChipPath(entry, path)))) {
        problems.push(`The app ${appId} is listed, but not for the chip path ${path}.`);
    }
    return { ok: problems.length === 0, origin, problems, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const result = await checkTapLink(process.argv[2]);
        for (const warning of result.warnings) console.warn(`warning: ${warning}`);
        if (result.ok) {
            console.log(`OK: ${result.origin} lets the JOEYY app open chip taps (${APP_ID}, ${CHIP_PATH}).`);
            console.log("Apple caches this file, so a change can take a while to reach phones. Reinstall the app to refresh it sooner.");
        } else {
            for (const problem of result.problems) console.error(`problem: ${problem}`);
            console.error(`NOT READY: tapping a chip on ${result.origin} will open Safari, not the app.`);
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Tap link check failed.");
        process.exitCode = 1;
    }
}
