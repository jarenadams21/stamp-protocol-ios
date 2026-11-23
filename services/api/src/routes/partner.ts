import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { verifyBearer, type AuthConfig } from "../auth.ts";
import { transaction } from "../db.ts";
import { ApiError, businessNotFound, invalid, programNotFound } from "../errors.ts";
import {
    IMAGE_KINDS,
    MAX_UPLOAD_BYTES,
    newImageKey,
    processImage,
    unsupportedImageType,
    type ImageKind,
    type ImageStore,
} from "../images.ts";
import { parseBusiness, parseInstant, parseProgram, sameProgram, unknownImage, type Theme } from "../validation.ts";
import { standsRoutes } from "./stands.ts";

declare module "fastify" {
    interface FastifyRequest {
        /** The verified token's `sub`. Partner routes resolve the business from it, never from the client. */
        subject: string;
    }
    interface FastifyContextConfig {
        /** Marks the upload route, so size and type errors get image-specific codes. */
        imageUpload?: boolean;
    }
}

export interface BusinessRow {
    id: string;
    name: string;
    location: string;
    logo_key: string | null;
    time_zone: string;
    current_version_id: string | null;
}

export interface VersionRow {
    id: string;
    version: number;
    required_punches: number;
    reward_description: string;
    theme: Theme;
    cover_key: string | null;
    published_at: Date;
    min_minutes_between_stamps: number | null;
}

const BUSINESS_FOR_SUBJECT = `
    SELECT b.id, b.name, b.location, b.logo_key, b.time_zone, b.current_version_id
    FROM businesses b JOIN business_owners o ON o.id = b.owner_id
    WHERE o.subject = $1`;

export const VERSION_COLUMNS = "id, version, required_punches, reward_description, theme, cover_key, published_at, min_minutes_between_stamps";

// Image URLs are short-lived, so apps should cache images by key and use the URL only to download.

export async function businessJSON(images: ImageStore, row: BusinessRow) {
    return {
        id: row.id,
        // The business ID doubles as the client ID that customers can search by.
        clientId: row.id,
        name: row.name,
        location: row.location,
        logoKey: row.logo_key,
        logoURL: row.logo_key ? await images.url(row.logo_key) : null,
        timeZone: row.time_zone,
        currentProgramVersionId: row.current_version_id,
    };
}

/** The card configuration contract (spec section 3.1). */
export async function versionJSON(images: ImageStore, row: VersionRow) {
    return {
        versionId: row.id,
        version: row.version,
        requiredPunches: row.required_punches,
        rewardDescription: row.reward_description,
        theme: {
            ...row.theme,
            coverKey: row.cover_key,
            coverURL: row.cover_key ? await images.url(row.cover_key) : null,
        },
        publishedAt: row.published_at.toISOString(),
        minMinutesBetweenStamps: row.min_minutes_between_stamps,
    };
}

/**
 * Turns the database refusing an image into unknownImage. requireImage checks first, but cleanup can
 * remove an old unused upload between that check and the save; the foreign key then catches it.
 */
function imageForeignKey(error: unknown): never {
    const { code, constraint } = error as { code?: string; constraint?: string };
    if (code === "23503" && (constraint === "businesses_logo_key_fkey" || constraint === "program_versions_cover_key_fkey")) {
        throw unknownImage();
    }
    throw error;
}

/** Throws unless `key` is an image of this kind that this business uploaded. */
async function requireImage(db: pg.PoolClient, businessId: string, kind: ImageKind, key: string): Promise<void> {
    const found = await db.query("SELECT 1 FROM images WHERE storage_key = $1 AND business_id = $2 AND kind = $3", [
        key,
        businessId,
        kind,
    ]);
    // Another business's key gets the same answer as a key that doesn't exist.
    if (found.rowCount !== 1) throw unknownImage();
}

export async function requireBusiness(db: pg.Pool | pg.PoolClient, subject: string, lock = false): Promise<BusinessRow> {
    const result = await db.query<BusinessRow>(BUSINESS_FOR_SUBJECT + (lock ? " FOR UPDATE OF b" : ""), [subject]);
    const row = result.rows[0];
    if (!row) throw businessNotFound();
    return row;
}

/** Notification cursors encode (created_at in microseconds since the epoch, id) so paging is exact. */
function encodeCursor(micros: string, id: string): string {
    return Buffer.from(`${micros}.${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { micros: string; id: string } {
    const match = Buffer.from(cursor, "base64url")
        .toString()
        .match(/^(\d{1,20})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
    if (!match?.[1] || !match[2]) throw invalid("invalidCursor", "Use the nextCursor from a previous response.");
    return { micros: match[1], id: match[2] };
}

export async function partnerRoutes(app: FastifyInstance, options: { pool: pg.Pool; auth: AuthConfig; images: ImageStore }) {
    const { pool, auth, images } = options;

    app.addHook("onRequest", async (request) => {
        request.subject = await verifyBearer(auth, request.headers.authorization, "partner");
    });

    // 1. Set up / edit business ---------------------------------------------------------------

    app.get("/business", async (request) => businessJSON(images, await requireBusiness(pool, request.subject)));

    app.put("/business", async (request, reply) => {
        const input = parseBusiness(request.body);
        const { row, created } = await transaction(pool, async (client) => {
            const owner = await client.query<{ id: string }>(
                `INSERT INTO business_owners (subject) VALUES ($1)
                 ON CONFLICT (subject) DO UPDATE SET subject = EXCLUDED.subject
                 RETURNING id`,
                [request.subject],
            );
            const saved = await client.query<BusinessRow & { created: boolean }>(
                `INSERT INTO businesses (owner_id, name, location, time_zone) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (owner_id) DO UPDATE
                     SET name = EXCLUDED.name, location = EXCLUDED.location, time_zone = EXCLUDED.time_zone
                 RETURNING id, name, location, logo_key, time_zone, current_version_id, (xmax = 0) AS created`,
                [owner.rows[0]!.id, input.name, input.location, input.timeZone],
            );
            const row = saved.rows[0]!;
            if (input.logoKey !== undefined && input.logoKey !== row.logo_key) {
                // A new business has no uploads yet, so its first save can't carry a logo.
                if (input.logoKey !== null) await requireImage(client, row.id, "logo", input.logoKey);
                await client.query("UPDATE businesses SET logo_key = $1 WHERE id = $2", [input.logoKey, row.id]);
                row.logo_key = input.logoKey;
            }
            return { row, created: row.created };
        }).catch(imageForeignKey);
        return reply.code(created ? 201 : 200).send(await businessJSON(images, row));
    });

    // Images (logo and cover photo) --------------------------------------------------------------

    // The body is the image itself, not JSON or a form. Signing in happens before the body is read.
    app.addContentTypeParser(["image/png", "image/jpeg"], { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) =>
        done(null, body),
    );

    app.post<{ Querystring: { kind?: string } }>(
        "/images",
        { bodyLimit: MAX_UPLOAD_BYTES, config: { imageUpload: true } },
        async (request, reply) => {
            const kind = request.query.kind as ImageKind;
            if (!IMAGE_KINDS.includes(kind)) throw invalid("invalidImageKind", `kind must be one of ${IMAGE_KINDS.join(", ")}.`);
            if (!Buffer.isBuffer(request.body)) throw unsupportedImageType();
            const business = await requireBusiness(pool, request.subject);
            const image = await processImage(request.body, kind);
            const key = newImageKey(business.id, kind, image.extension);
            try {
                await images.put(key, image.data, image.contentType);
            } catch (error) {
                request.log.error({ err: error }, "image upload to storage failed");
                throw new ApiError(503, "imageStorageUnavailable", "Images can't be saved right now. Try again.");
            }
            try {
                await pool.query(
                    `INSERT INTO images (business_id, kind, storage_key, content_type, byte_size, width, height)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [business.id, kind, key, image.contentType, image.data.length, image.width, image.height],
                );
            } catch (error) {
                // Don't leave a stored file that no record points to.
                await images.remove(key).catch(() => {});
                throw error;
            }
            return reply.code(201).send({
                key,
                kind,
                url: await images.url(key),
                contentType: image.contentType,
                width: image.width,
                height: image.height,
                byteSize: image.data.length,
            });
        },
    );

    // 2. Read / publish card rules --------------------------------------------------------------

    app.get("/program", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        if (!business.current_version_id) throw programNotFound();
        const result = await pool.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM program_versions WHERE id = $1`, [
            business.current_version_id,
        ]);
        return versionJSON(images, result.rows[0]!);
    });

    app.get("/program/versions", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        const result = await pool.query<VersionRow & { in_progress: number; completed: number }>(
            `SELECT v.id, v.version, v.required_punches, v.reward_description, v.theme, v.cover_key, v.published_at,
                    v.min_minutes_between_stamps,
                    COUNT(c.id) FILTER (WHERE c.status = 'active')::int AS in_progress,
                    COUNT(c.id) FILTER (WHERE c.status IN ('completed', 'closed'))::int AS completed
             FROM program_versions v
             LEFT JOIN cards c ON c.program_version_id = v.id AND c.business_id = v.business_id
             WHERE v.business_id = $1
             GROUP BY v.id
             ORDER BY v.version DESC`,
            [business.id],
        );
        return {
            versions: await Promise.all(
                result.rows.map(async (row) => ({
                    ...(await versionJSON(images, row)),
                    usage: {
                        // Live: issued to new cards. Finishing: older, cards still in progress. Retired: older, none.
                        status: row.id === business.current_version_id ? "live" : row.in_progress > 0 ? "finishing" : "retired",
                        inProgress: row.in_progress,
                        completed: row.completed,
                    },
                })),
            ),
        };
    });

    app.get("/program/publish-impact", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        const result = await pool.query<{ keep_rules: number; switch_to_new: number }>(
            `SELECT COUNT(*) FILTER (WHERE punches > 0)::int AS keep_rules,
                    COUNT(*) FILTER (WHERE punches = 0)::int AS switch_to_new
             FROM cards WHERE business_id = $1 AND status = 'active'`,
            [business.id],
        );
        const row = result.rows[0]!;
        return { keepRules: row.keep_rules, switchToNew: row.switch_to_new };
    });

    app.post("/program/versions", async (request, reply) => {
        const input = parseProgram(request.body);
        const version = await transaction(pool, async (client) => {
            // Locking the business row serializes publishes, so version numbers never collide.
            const business = await requireBusiness(client, request.subject, true);
            if (business.current_version_id) {
                const current = await client.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM program_versions WHERE id = $1`, [
                    business.current_version_id,
                ]);
                const live = current.rows[0]!;
                const liveInput = {
                    requiredPunches: live.required_punches,
                    rewardDescription: live.reward_description,
                    theme: live.theme,
                    coverKey: live.cover_key,
                    minMinutesBetweenStamps: live.min_minutes_between_stamps,
                };
                if (sameProgram(input, liveInput)) {
                    throw new ApiError(409, "unchangedProgram", "This matches the published card. Make a change before publishing.");
                }
            }
            if (input.coverKey) await requireImage(client, business.id, "cover", input.coverKey);
            const inserted = await client.query<VersionRow>(
                `INSERT INTO program_versions
                     (business_id, version, required_punches, reward_description, theme, cover_key, min_minutes_between_stamps)
                 SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6 FROM program_versions WHERE business_id = $1
                 RETURNING ${VERSION_COLUMNS}`,
                [business.id, input.requiredPunches, input.rewardDescription, input.theme, input.coverKey, input.minMinutesBetweenStamps],
            );
            const row = inserted.rows[0]!;
            await client.query("UPDATE businesses SET current_version_id = $1 WHERE id = $2", [row.id, business.id]);
            // Cards with no punches move to the new version, since no progress is lost (spec section 4).
            await client.query(
                `UPDATE cards SET program_version_id = $1
                 WHERE business_id = $2 AND status = 'active' AND punches = 0`,
                [row.id, business.id],
            );
            return row;
        }).catch(imageForeignKey);
        return reply.code(201).send(await versionJSON(images, version));
    });

    // 3. View dashboard -------------------------------------------------------------------------

    app.get<{ Querystring: { from?: string; to?: string } }>("/dashboard", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        const from = request.query.from === undefined ? null : parseInstant(request.query.from, "from");
        const to = parseInstant(request.query.to, "to");
        if (from && from > to) throw invalid("invalidRange", "from must not be after to.");
        // Activity uses the half-open range from <= timestamp < to; the rest is all-time (section 8.4).
        const result = await pool.query(
            `SELECT
                (SELECT COUNT(DISTINCT customer_id) FROM cards WHERE business_id = $1)::int AS "enrolledCardholders",
                (SELECT COUNT(*) FROM punches WHERE business_id = $1
                    AND ($2::timestamptz IS NULL OR occurred_at >= $2) AND occurred_at < $3)::int AS "punches",
                (SELECT COUNT(*) FROM rewards WHERE business_id = $1
                    AND ($2::timestamptz IS NULL OR earned_at >= $2) AND earned_at < $3)::int AS "rewardsEarned",
                (SELECT COUNT(*) FROM rewards WHERE business_id = $1
                    AND ($2::timestamptz IS NULL OR redeemed_at >= $2) AND redeemed_at < $3)::int AS "rewardsRedeemed",
                (SELECT COUNT(*) FROM rewards WHERE business_id = $1 AND redeemed_at IS NULL)::int AS "rewardsWaiting",
                (SELECT COUNT(*) FROM (
                    SELECT customer_id FROM rewards WHERE business_id = $1 AND redeemed_at IS NULL
                    GROUP BY customer_id HAVING COUNT(*) > 1
                ) stacked)::int AS "customersWithStackedRewards"`,
            [business.id, from, to],
        );
        return result.rows[0];
    });

    // Notifications (section 7) -----------------------------------------------------------------

    app.get<{ Querystring: { after?: string; limit?: string } }>("/notifications", async (request) => {
        const business = await requireBusiness(pool, request.subject);
        const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("invalidLimit", "limit must be 1 to 100.");
        const after = request.query.after === undefined ? null : decodeCursor(request.query.after);
        const result = await pool.query<{
            id: string;
            kind: string;
            payload: Record<string, unknown>;
            created_at: Date;
            read_at: Date | null;
            micros: string;
        }>(
            `SELECT id, kind, payload, created_at, read_at,
                    (EXTRACT(EPOCH FROM created_at) * 1000000)::bigint::text AS micros
             FROM notifications
             WHERE business_id = $1
               AND ($2::bigint IS NULL OR (created_at, id) < (timestamptz 'epoch' + $2::bigint * interval '1 microsecond', $3::uuid))
             ORDER BY created_at DESC, id DESC
             LIMIT $4`,
            [business.id, after?.micros ?? null, after?.id ?? null, limit + 1],
        );
        const page = result.rows.slice(0, limit);
        const last = page.at(-1);
        return {
            notifications: page.map((row) => ({
                id: row.id,
                kind: row.kind,
                payload: row.payload,
                createdAt: row.created_at.toISOString(),
                readAt: row.read_at?.toISOString() ?? null,
            })),
            nextCursor: result.rows.length > limit && last ? encodeCursor(last.micros, last.id) : null,
        };
    });

    // Stands and activity (docs/web-connect.md): a child plugin, so the owner token hook above applies.
    await app.register(standsRoutes, { pool });
}
