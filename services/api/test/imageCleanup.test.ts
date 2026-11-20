import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { cleanUpImages, imageCleanupFromEnv, unusedForMsFromEnv } from "../src/imageCleanup.ts";
import { AzureImageStore, type ImageStore } from "../src/images.ts";
import { asPartner, businessWithProgram, download, setUp, uploadImage, validTheme, type TestContext } from "./helpers.ts";

let ctx: TestContext;
before(async () => {
    ctx = await setUp();
});
after(async () => {
    await ctx?.close();
});

const DAY = 24 * 60 * 60 * 1000;
const clean = (store: ImageStore = ctx.images, options: { dryRun?: boolean } = {}) =>
    cleanUpImages(ctx.pool, store, { unusedForMs: DAY, ...options });

const png = () => sharp({ create: { width: 16, height: 16, channels: 3, background: "#884422" } }).png().toBuffer();
const jpeg = () => sharp({ create: { width: 16, height: 16, channels: 3, background: "#224488" } }).jpeg().toBuffer();

async function upload(subject: string, kind: "logo" | "cover"): Promise<string> {
    const response = await uploadImage(ctx, subject, kind, kind === "logo" ? await png() : await jpeg(), kind === "logo" ? "image/png" : "image/jpeg");
    assert.equal(response.status, 201);
    return response.body.key;
}

/** Makes uploads look older than the grace period. */
async function age(...keys: string[]) {
    await ctx.pool.query("UPDATE images SET created_at = now() - interval '2 days' WHERE storage_key = ANY($1)", [keys]);
}

/** True when the file is still in storage. */
async function stored(key: string): Promise<boolean> {
    const response = await download(ctx, await ctx.images.url(key));
    return response.statusCode === 200;
}

async function recorded(key: string): Promise<boolean> {
    return (await ctx.pool.query("SELECT 1 FROM images WHERE storage_key = $1", [key])).rowCount === 1;
}

async function queue() {
    return (await ctx.pool.query<{ storage_key: string; attempts: number; last_error: string | null }>(
        "SELECT storage_key, attempts, last_error FROM image_deletions ORDER BY storage_key",
    )).rows;
}

const publish = (subject: string, coverKey: string | null) =>
    asPartner(ctx, subject, "POST", "/v1/partner/program/versions", {
        requiredPunches: 8,
        rewardDescription: `Reward ${crypto.randomUUID().slice(0, 8)}`,
        theme: { ...validTheme, coverKey },
    });

describe("image cleanup", () => {
    test("removes old uploads nothing uses, and keeps logos, covers on any version, and recent uploads", async () => {
        await businessWithProgram(ctx, "clean-a");
        const logo = await upload("clean-a", "logo");
        await asPartner(ctx, "clean-a", "PUT", "/v1/partner/business", { name: "Clean A", logoKey: logo });
        const oldCover = await upload("clean-a", "cover");
        assert.equal((await publish("clean-a", oldCover)).status, 201);
        // A newer version without the cover: the old version still shows it in history.
        assert.equal((await publish("clean-a", null)).status, 201);
        const abandoned = await upload("clean-a", "logo");
        const recent = await upload("clean-a", "cover");
        await age(logo, oldCover, abandoned);

        const result = await clean();
        assert.equal(result.skipped, false);
        assert.deepEqual(result.unused, [abandoned]);
        assert.equal(result.deleted, 1);
        assert.deepEqual([result.failed, result.pending], [0, 0]);

        assert.equal(await recorded(abandoned), false);
        assert.equal(await stored(abandoned), false);
        for (const key of [logo, oldCover, recent]) {
            assert.equal(await recorded(key), true, key);
            assert.equal(await stored(key), true, key);
        }
        assert.deepEqual(await queue(), []);

        // Nothing left to do on a second run.
        assert.deepEqual(await clean(), { skipped: false, unused: [], deleted: 0, failed: 0, pending: 0 });
    });

    test("a replaced logo is removed, and the business keeps showing its current one", async () => {
        await businessWithProgram(ctx, "clean-logo");
        const first = await upload("clean-logo", "logo");
        await asPartner(ctx, "clean-logo", "PUT", "/v1/partner/business", { name: "Logo", logoKey: first });
        const second = await upload("clean-logo", "logo");
        await asPartner(ctx, "clean-logo", "PUT", "/v1/partner/business", { name: "Logo", logoKey: second });
        await age(first, second);

        const result = await clean();
        assert.deepEqual(result.unused, [first]);
        assert.equal(await stored(first), false);
        const business = await asPartner(ctx, "clean-logo", "GET", "/v1/partner/business");
        assert.equal(business.body.logoKey, second);
        assert.equal((await download(ctx, business.body.logoURL)).statusCode, 200);
    });

    test("a dry run lists what would be removed and changes nothing", async () => {
        await businessWithProgram(ctx, "clean-dry");
        const abandoned = await upload("clean-dry", "cover");
        await age(abandoned);

        const result = await clean(ctx.images, { dryRun: true });
        assert.deepEqual(result.unused, [abandoned]);
        assert.equal(result.deleted, 0);
        assert.equal(await recorded(abandoned), true);
        assert.equal(await stored(abandoned), true);

        await clean();
        assert.equal(await stored(abandoned), false);
    });

    test("saving an upload that cleanup already removed is unknownImage, not a server error", async () => {
        await businessWithProgram(ctx, "clean-late");
        const logo = await upload("clean-late", "logo");
        const cover = await upload("clean-late", "cover");
        await age(logo, cover);
        await clean();

        const saved = await asPartner(ctx, "clean-late", "PUT", "/v1/partner/business", { name: "Late", logoKey: logo });
        assert.deepEqual([saved.status, saved.body.error], [400, "unknownImage"]);
        const published = await publish("clean-late", cover);
        assert.deepEqual([published.status, published.body.error], [400, "unknownImage"]);
    });

    test("deleting a business queues every one of its files, and cleanup deletes them", async () => {
        const { businessId } = await businessWithProgram(ctx, "clean-gone");
        const logo = await upload("clean-gone", "logo");
        await asPartner(ctx, "clean-gone", "PUT", "/v1/partner/business", { name: "Gone", logoKey: logo });
        const cover = await upload("clean-gone", "cover");
        assert.equal((await publish("clean-gone", cover)).status, 201);
        const unsaved = await upload("clean-gone", "cover");

        // There's no delete route yet; account deletion will remove the business row like this.
        await ctx.pool.query("DELETE FROM businesses WHERE id = $1", [businessId]);
        assert.deepEqual(
            (await queue()).map((row) => row.storage_key),
            [logo, cover, unsaved].sort(),
        );

        // Queued files are deleted right away: there's no grace period once the row is gone.
        const result = await clean();
        assert.deepEqual(result.unused, []);
        assert.equal(result.deleted, 3);
        for (const key of [logo, cover, unsaved]) assert.equal(await stored(key), false, key);
        assert.deepEqual(await queue(), []);
    });

    test("a file storage can't delete stays queued and is retried", async () => {
        await businessWithProgram(ctx, "clean-retry");
        const abandoned = await upload("clean-retry", "logo");
        await age(abandoned);

        const failing: ImageStore = {
            label: "failing store",
            put: (key, data) => ctx.images.put(key, data),
            url: (key) => ctx.images.url(key),
            remove: async () => {
                throw new Error("storage is down");
            },
        };
        const first = await clean(failing);
        assert.deepEqual(first.unused, [abandoned]);
        assert.deepEqual([first.deleted, first.failed, first.pending], [0, 1, 1]);
        assert.deepEqual(await queue(), [{ storage_key: abandoned, attempts: 1, last_error: "storage is down" }]);
        // The row is gone, so nothing can attach it, but the file waits in storage for the retry.
        assert.equal(await recorded(abandoned), false);
        assert.equal(await stored(abandoned), true);

        const retry = await clean();
        assert.deepEqual([retry.deleted, retry.failed, retry.pending], [1, 0, 0]);
        assert.equal(await stored(abandoned), false);
    });

    test("never deletes a queued name this API didn't issue", async () => {
        await ctx.pool.query("INSERT INTO image_deletions (storage_key) VALUES ('../package.json')");
        const result = await clean();
        assert.deepEqual([result.deleted, result.failed, result.pending], [0, 1, 1]);
        const [row] = await queue();
        assert.match(row!.last_error!, /Not an image key/);
        await ctx.pool.query("DELETE FROM image_deletions");
    });

    test("only one cleanup runs at a time", async () => {
        const holder = await ctx.pool.connect();
        try {
            await holder.query("SELECT pg_advisory_lock(hashtext('joeyy.image-cleanup'), hashtext(current_schema()))");
            assert.deepEqual(await clean(), { skipped: true, unused: [], deleted: 0, failed: 0, pending: 0 });
        } finally {
            await holder.query("SELECT pg_advisory_unlock(hashtext('joeyy.image-cleanup'), hashtext(current_schema()))");
            holder.release();
        }
        assert.equal((await clean()).skipped, false);
    });
});

describe("cleanup settings", () => {
    const azure = new AzureImageStore({
        account: "example",
        container: "images",
        urlTtlSeconds: 900,
        credential: { getToken: async () => null },
    });

    test("runs by default with Azure, not with the local folder, and can be switched", () => {
        assert.deepEqual(imageCleanupFromEnv({}, azure), { unusedForMs: DAY });
        assert.equal(imageCleanupFromEnv({}, ctx.images), null);
        assert.deepEqual(imageCleanupFromEnv({ IMAGE_CLEANUP: "on" }, ctx.images), { unusedForMs: DAY });
        assert.equal(imageCleanupFromEnv({ IMAGE_CLEANUP: "off" }, azure), null);
        assert.throws(() => imageCleanupFromEnv({ IMAGE_CLEANUP: "yes" }, azure), /IMAGE_CLEANUP/);
    });

    test("the grace period is 1 to 720 whole hours", () => {
        assert.equal(unusedForMsFromEnv({ IMAGE_UNUSED_HOURS: "48" }), 2 * DAY);
        for (const value of ["0", "721", "1.5", "soon"]) {
            assert.throws(() => unusedForMsFromEnv({ IMAGE_UNUSED_HOURS: value }), /IMAGE_UNUSED_HOURS/, value);
        }
    });
});
