// Fills a development API with the website demo's sample places, through the API's own routes, so
// Discover and taps have something to show. AUTH_MODE=dev only (it signs its own owner tokens and
// uses /v1/dev/stands/touch). Safe to run again: places that already exist are left as they are.
//   npm run seed:places                       -> http://localhost:8080
//   npm run seed:places -- http://localhost:5181
import { devSigner } from "../src/auth.ts";

// One source of truth: the website demo's own sample places. Loaded at run time so this package's
// type check doesn't pull in the web app's files (they follow the web app's module rules).
interface SamplePlace {
    business: { name: string; location: string };
    program: {
        requiredPunches: number;
        rewardDescription: string;
        minMinutesBetweenStamps?: number;
        theme: { lightPaper: string; lightInk: string; darkPaper: string; darkInk: string; typeface: string; artwork: string; allowsMotion: boolean };
    };
}
const samples = new URL("../../../apps/web/server/demo/data.ts", import.meta.url).href;
const { BUSINESSES } = (await import(samples)) as { BUSINESSES: Record<string, SamplePlace> };

const base = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const signer = await devSigner({ persist: true });

async function call(token: string, method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

for (const [key, { business, program }] of Object.entries(BUSINESSES)) {
    const token = await signer.sign("partner", `sample:${key}`, "10m");
    const existing = await call(token, "GET", "/v1/partner/business");
    if (existing.status === 200) {
        console.log(`${business.name}: already there`);
        continue;
    }
    const saved = await call(token, "PUT", "/v1/partner/business", {
        name: business.name,
        location: business.location,
        timeZone: business.location.includes("Vancouver") ? "America/Vancouver" : "America/Los_Angeles",
    });
    if (saved.status >= 300) throw new Error(`${business.name}: business ${saved.status} ${JSON.stringify(saved.body)}`);
    const { theme } = program;
    const published = await call(token, "POST", "/v1/partner/program/versions", {
        requiredPunches: Math.min(12, program.requiredPunches),
        rewardDescription: program.rewardDescription,
        ...(program.minMinutesBetweenStamps ? { minMinutesBetweenStamps: program.minMinutesBetweenStamps } : {}),
        theme: {
            lightPaper: theme.lightPaper, lightInk: theme.lightInk, darkPaper: theme.darkPaper, darkInk: theme.darkInk,
            typeface: theme.typeface, artwork: theme.artwork, allowsMotion: theme.allowsMotion, coverKey: null,
        },
    });
    if (published.status >= 300) throw new Error(`${business.name}: card ${published.status} ${JSON.stringify(published.body)}`);
    await call(token, "POST", "/v1/partner/stands/pairing");
    const stands = await call(token, "POST", "/v1/dev/stands/touch");
    if (stands.status >= 300) throw new Error(`${business.name}: stand ${stands.status} ${JSON.stringify(stands.body)}`);
    console.log(`${business.name}: added with a counter stand`);
}
