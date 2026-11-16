import { invalid } from "./errors.ts";
import { isImageKey } from "./images.ts";

// Server-side copies of the apps' rules (docs/backend-spec.md section 3.1). Keep in sync with
// JOEYY/BusinessModels.swift (Business, ProgramDraft) and JOEYY/MerchantBranding.swift (MerchantTheme).

export const NAME_LIMIT = 40; // Business.nameLimit
export const LOCATION_LIMIT = 120; // Business.locationLimit
export const PUNCH_RANGE = { min: 3, max: 12 }; // Place.punchRange
export const REWARD_LIMIT = 60; // ProgramDraft.rewardLimit

export const TYPEFACES = ["standard", "rounded", "serif", "monospaced"] as const;
export const ARTWORKS = ["rail", "cloud", "stone"] as const;

export interface Theme {
    lightPaper: string;
    lightInk: string;
    darkPaper: string;
    darkInk: string;
    typeface: (typeof TYPEFACES)[number];
    artwork: (typeof ARTWORKS)[number];
    allowsMotion: boolean;
}

export interface BusinessInput {
    name: string;
    location: string;
    timeZone: string;
    /** A key from POST /images, null to remove the logo, or undefined to leave it as it is. */
    logoKey?: string | null;
}

export interface ProgramInput {
    requiredPunches: number;
    rewardDescription: string;
    theme: Theme;
    /** A key from POST /images, or null for the card's original artwork. */
    coverKey: string | null;
}

/** Thrown for a key that is malformed, of the wrong kind, or not this business's upload. */
export const unknownImage = () => invalid("unknownImage", "Upload the image again, then save.");

/** Accepts an issued image key or null. Ownership and kind are checked against the database. */
function parseImageKey(value: unknown): string | null {
    if (value === null) return null;
    if (!isImageKey(value)) throw unknownImage();
    return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Character count as Swift's String.count sees it (grapheme clusters), so limits match the apps. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function characterCount(text: string): number {
    let count = 0;
    for (const _ of segmenter.segment(text)) count += 1;
    return count;
}

const timeZones = new Set(Intl.supportedValuesOf("timeZone"));
timeZones.add("UTC");

export function parseBusiness(body: unknown): BusinessInput {
    if (!isObject(body)) throw invalid("invalidBody", "Send a JSON object.");
    if (typeof body.name !== "string") throw invalid("missingName", "Enter your business name.");
    const name = body.name.trim();
    if (name.length === 0) throw invalid("missingName", "Enter your business name.");
    if (characterCount(name) > NAME_LIMIT) {
        throw invalid("nameTooLong", `Use ${NAME_LIMIT} characters or fewer for the business name.`);
    }
    if (body.location !== undefined && typeof body.location !== "string") {
        throw invalid("invalidLocation", "Location must be text.");
    }
    const location = (body.location ?? "").trim();
    if (characterCount(location) > LOCATION_LIMIT) {
        throw invalid("locationTooLong", `Use ${LOCATION_LIMIT} characters or fewer for the location.`);
    }
    const timeZone = body.timeZone ?? "UTC";
    if (typeof timeZone !== "string" || !timeZones.has(timeZone)) {
        throw invalid("invalidTimeZone", "Use an IANA time zone, such as America/Los_Angeles.");
    }
    return {
        name,
        location,
        timeZone,
        ...(body.logoKey === undefined ? {} : { logoKey: parseImageKey(body.logoKey) }),
    };
}

/** Accepts "#RRGGBB" (any case) and returns it uppercased, or undefined if malformed. */
function parseHex(value: unknown): string | undefined {
    if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) return undefined;
    return value.toUpperCase();
}

/** WCAG contrast ratio, identical to MerchantTheme.contrast. */
export function contrast(first: string, second: string): number {
    const luminance = (hex: string) => {
        const value = Number.parseInt(hex.slice(1), 16);
        const [r, g, b] = [16, 8, 0].map((shift) => {
            const component = ((value >> shift) & 255) / 255;
            return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const values = [luminance(first), luminance(second)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

const invalidTheme = () =>
    invalid("invalidTheme", "Card colors must provide at least 4.5:1 text contrast in light and dark mode.");

export function parseTheme(value: unknown): Theme {
    if (!isObject(value)) throw invalidTheme();
    const lightPaper = parseHex(value.lightPaper);
    const lightInk = parseHex(value.lightInk);
    const darkPaper = parseHex(value.darkPaper);
    const darkInk = parseHex(value.darkInk);
    if (!lightPaper || !lightInk || !darkPaper || !darkInk) throw invalidTheme();
    if (contrast(lightPaper, lightInk) < 4.5 || contrast(darkPaper, darkInk) < 4.5) throw invalidTheme();
    if (!TYPEFACES.includes(value.typeface as Theme["typeface"])) {
        throw invalid("invalidTheme", `typeface must be one of ${TYPEFACES.join(", ")}.`);
    }
    if (!ARTWORKS.includes(value.artwork as Theme["artwork"])) {
        throw invalid("invalidTheme", `artwork must be one of ${ARTWORKS.join(", ")}.`);
    }
    if (typeof value.allowsMotion !== "boolean") throw invalid("invalidTheme", "allowsMotion must be true or false.");
    if (value.coverURL !== undefined && value.coverURL !== null) {
        // Covers are uploaded through the API and served by short-lived URLs; clients can't set one.
        throw invalid("invalidTheme", "coverURL is set by the server. Upload a cover image instead.");
    }
    return {
        lightPaper,
        lightInk,
        darkPaper,
        darkInk,
        typeface: value.typeface as Theme["typeface"],
        artwork: value.artwork as Theme["artwork"],
        allowsMotion: value.allowsMotion,
    };
}

export function parseProgram(body: unknown): ProgramInput {
    if (!isObject(body)) throw invalid("invalidBody", "Send a JSON object.");
    const { requiredPunches } = body;
    if (
        typeof requiredPunches !== "number" ||
        !Number.isInteger(requiredPunches) ||
        requiredPunches < PUNCH_RANGE.min ||
        requiredPunches > PUNCH_RANGE.max
    ) {
        throw invalid("invalidPunches", `Choose between ${PUNCH_RANGE.min} and ${PUNCH_RANGE.max} punches.`);
    }
    if (typeof body.rewardDescription !== "string") throw invalid("missingReward", "Describe the reward customers earn.");
    const rewardDescription = body.rewardDescription.trim();
    if (rewardDescription.length === 0) throw invalid("missingReward", "Describe the reward customers earn.");
    if (characterCount(rewardDescription) > REWARD_LIMIT) {
        throw invalid("rewardTooLong", `Use ${REWARD_LIMIT} characters or fewer for the reward.`);
    }
    const theme = parseTheme(body.theme);
    // The cover travels with the theme, as theme.coverKey. Leaving it out publishes without a cover.
    const coverKey = parseImageKey((body.theme as Record<string, unknown>).coverKey ?? null);
    return { requiredPunches, rewardDescription, theme, coverKey };
}

/** True when two programs would look and behave identically (publishing would change nothing). */
export function sameProgram(a: ProgramInput, b: ProgramInput): boolean {
    const keys: (keyof Theme)[] = ["lightPaper", "lightInk", "darkPaper", "darkInk", "typeface", "artwork", "allowsMotion"];
    return (
        a.requiredPunches === b.requiredPunches &&
        a.rewardDescription === b.rewardDescription &&
        a.coverKey === b.coverKey &&
        keys.every((key) => a.theme[key] === b.theme[key])
    );
}

/** Parses an ISO 8601 instant that includes a time zone (for example ...Z or ...-08:00). */
export function parseInstant(value: unknown, name: string): Date {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
        throw invalid("invalidRange", `${name} must be an ISO 8601 instant, such as 2026-11-09T08:00:00Z.`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw invalid("invalidRange", `${name} is not a valid date.`);
    return date;
}
