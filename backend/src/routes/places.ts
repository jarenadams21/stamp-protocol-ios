import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { invalid, placeNotFound } from "../errors.ts";
import type { ImageStore } from "../images.ts";
import { characterCount, NAME_LIMIT } from "../validation.ts";
import { businessJSON, versionJSON, type BusinessRow, type VersionRow } from "./partner.ts";

// Places (spec section 8.2): find a business by name or client ID, then read it with its live card.
// Open to anyone, no sign-in: a place's name, location and card are public, like a menu in the
// window, and the website's Discover page shows them before anyone signs in. Nothing here is
// about a customer. Only businesses with a published card are places; one still being set up isn't
// shown, and reads the same as an ID that doesn't exist.

const SEARCH_LIMIT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLACE_COLUMNS = `
    b.id, b.name, b.location, b.logo_key, b.time_zone, b.current_version_id,
    v.id AS v_id, v.version AS v_version, v.required_punches AS v_required_punches,
    v.reward_description AS v_reward_description, v.theme AS v_theme, v.cover_key AS v_cover_key,
    v.published_at AS v_published_at`;

const PLACE_FROM = "FROM businesses b JOIN program_versions v ON v.id = b.current_version_id AND v.business_id = b.id";

type PlaceRow = BusinessRow & {
    v_id: string;
    v_version: number;
    v_required_punches: number;
    v_reward_description: string;
    v_theme: VersionRow["theme"];
    v_cover_key: string | null;
    v_published_at: Date;
};

/** A place is its business (the same fields the partner app sees) and its live card (section 3.1). */
async function placeJSON(images: ImageStore, row: PlaceRow) {
    return {
        ...(await businessJSON(images, row)),
        program: await versionJSON(images, {
            id: row.v_id,
            version: row.v_version,
            required_punches: row.v_required_punches,
            reward_description: row.v_reward_description,
            theme: row.v_theme,
            cover_key: row.v_cover_key,
            published_at: row.v_published_at,
        }),
    };
}

/** Escapes LIKE wildcards so a search for "100%" means the text, not a pattern. */
function likeText(text: string): string {
    return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function parseQuery(value: unknown): string {
    const query = typeof value === "string" ? value.trim() : "";
    if (!query) throw invalid("invalidQuery", "Type a place's name to search.");
    // A client ID is 36 characters; names are at most NAME_LIMIT.
    if (characterCount(query) > Math.max(NAME_LIMIT, 36)) throw invalid("invalidQuery", "Use a shorter search.");
    return query;
}

export async function placesRoutes(app: FastifyInstance, options: { pool: pg.Pool; images: ImageStore }) {
    const { pool, images } = options;

    app.get<{ Querystring: { query?: string } }>("/", async (request) => {
        const query = parseQuery(request.query.query);
        const text = likeText(query);
        const clientId = UUID.test(query) ? query.toLowerCase() : null;
        // An exact client ID first, then names that start with the query, then names that contain it.
        const result = await pool.query<PlaceRow>(
            `SELECT ${PLACE_COLUMNS} ${PLACE_FROM}
             WHERE b.name ILIKE '%' || $1 || '%' OR b.id = $2::uuid
             ORDER BY b.id = $2::uuid IS TRUE DESC, b.name ILIKE $1 || '%' DESC, lower(b.name), b.id
             LIMIT $3`,
            [text, clientId, SEARCH_LIMIT],
        );
        return { places: await Promise.all(result.rows.map((row) => placeJSON(images, row))) };
    });

    app.get<{ Params: { placeId: string } }>("/:placeId", async (request) => {
        const { placeId } = request.params;
        if (!UUID.test(placeId)) throw placeNotFound();
        const result = await pool.query<PlaceRow>(`SELECT ${PLACE_COLUMNS} ${PLACE_FROM} WHERE b.id = $1`, [placeId.toLowerCase()]);
        const row = result.rows[0];
        if (!row) throw placeNotFound();
        return placeJSON(images, row);
    });
}
