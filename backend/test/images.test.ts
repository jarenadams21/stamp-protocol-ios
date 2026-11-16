import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { AzureImageStore, MAX_UPLOAD_BYTES, processImage } from "../src/images.ts";
import { asPartner, businessWithProgram, download, setUp, uploadImage, validTheme, type TestContext } from "./helpers.ts";

let ctx: TestContext;
before(async () => {
    ctx = await setUp();
});
after(async () => {
    await ctx?.close();
});

/** A solid-color test image. */
function picture(format: "png" | "jpeg" | "webp" | "gif", width = 64, height = 48) {
    return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
        .toFormat(format)
        .toBuffer();
}

describe("image processing", () => {
    test("keeps PNG and JPEG, and tells the real format from the bytes", async () => {
        const png = await processImage(await picture("png"), "logo");
        assert.deepEqual([png.contentType, png.extension, png.width, png.height], ["image/png", "png", 64, 48]);
        const jpeg = await processImage(await picture("jpeg"), "cover");
        assert.deepEqual([jpeg.contentType, jpeg.extension], ["image/jpeg", "jpg"]);
        assert.equal((await sharp(jpeg.data).metadata()).format, "jpeg");
    });

    test("rejects other formats, unreadable files, and oversized files", async () => {
        for (const format of ["webp", "gif"] as const) {
            await assert.rejects(processImage(await picture(format), "logo"), { code: "unsupportedImageType", status: 415 });
        }
        await assert.rejects(processImage(Buffer.from("not an image at all"), "logo"), { code: "invalidImage", status: 400 });
        await assert.rejects(processImage(Buffer.alloc(0), "logo"), { code: "invalidImage" });
        const truncated = (await picture("png", 400, 400)).subarray(0, 200);
        await assert.rejects(processImage(truncated, "logo"), { code: "invalidImage" });
        await assert.rejects(processImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "logo"), { code: "imageTooLarge", status: 413 });
    });

    test("strips metadata, including location, and applies the camera's rotation", async () => {
        const original = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#336699" } })
            .jpeg()
            .withExif({ IFD0: { Copyright: "Secret Owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "47/1 36/1 0/1" } })
            .withMetadata({ orientation: 6 })
            .toBuffer();
        assert.ok(original.includes("Secret Owner"));
        const before = await sharp(original).metadata();
        assert.ok(before.exif, "the test image should carry EXIF");
        assert.equal(before.orientation, 6);

        const processed = await processImage(original, "cover");
        const after = await sharp(processed.data).metadata();
        assert.equal(after.exif, undefined);
        assert.equal(after.icc, undefined);
        assert.equal(after.orientation, undefined);
        assert.equal(processed.data.includes("Secret Owner"), false);
        // Orientation 6 means the picture is stored sideways; the stored copy is turned upright.
        assert.deepEqual([processed.width, processed.height], [40, 80]);
    });

    test("scales large images down and never scales small ones up", async () => {
        const logo = await processImage(await picture("png", 3000, 1500), "logo");
        assert.deepEqual([logo.width, logo.height], [1024, 512]);
        const cover = await processImage(await picture("jpeg", 3000, 1500), "cover");
        assert.deepEqual([cover.width, cover.height], [2048, 1024]);
        const small = await processImage(await picture("png", 10, 20), "cover");
        assert.deepEqual([small.width, small.height], [10, 20]);
    });
});

describe("POST /v1/partner/images", () => {
    test("needs a token and a business", async () => {
        const anonymous = await ctx.app.inject({
            method: "POST",
            url: "/v1/partner/images?kind=logo",
            headers: { "content-type": "image/png" },
            payload: await picture("png"),
        });
        assert.equal(anonymous.statusCode, 401);
        const noBusiness = await uploadImage(ctx, "img-nobody", "logo", await picture("png"));
        assert.equal(noBusiness.status, 404);
        assert.equal(noBusiness.body.error, "businessNotFound");
    });

    test("stores the image under the caller's business and returns a working, expiring URL", async () => {
        const { businessId } = await businessWithProgram(ctx, "img-owner");
        const uploaded = await uploadImage(ctx, "img-owner", "logo", await picture("png", 2000, 1000));
        assert.equal(uploaded.status, 201);
        assert.match(uploaded.body.key, new RegExp(`^businesses/${businessId}/logo/[0-9a-f-]{36}\\.png$`));
        assert.deepEqual(
            [uploaded.body.kind, uploaded.body.contentType, uploaded.body.width, uploaded.body.height],
            ["logo", "image/png", 1024, 512],
        );

        const image = await download(ctx, uploaded.body.url);
        assert.equal(image.statusCode, 200);
        assert.equal(image.headers["content-type"], "image/png");
        assert.equal(image.rawPayload.length, uploaded.body.byteSize);
        assert.equal((await sharp(image.rawPayload).metadata()).width, 1024);

        const row = await ctx.pool.query("SELECT business_id, kind, byte_size FROM images WHERE storage_key = $1", [uploaded.body.key]);
        assert.deepEqual(row.rows, [{ business_id: businessId, kind: "logo", byte_size: uploaded.body.byteSize }]);

        // The link is the only way in: no signature, a changed signature, another key, or an old link all fail.
        const url = new URL(uploaded.body.url);
        const get = (path: string) => ctx.app.inject({ method: "GET", url: path });
        assert.equal((await get(url.pathname)).statusCode, 403);
        assert.equal((await get(`${url.pathname}?expires=${url.searchParams.get("expires")}&signature=AAAA`)).statusCode, 403);
        const later = Number(url.searchParams.get("expires")) + 3600;
        assert.equal((await get(`${url.pathname}?expires=${later}&signature=${url.searchParams.get("signature")}`)).statusCode, 403);
        const other = await uploadImage(ctx, "img-owner", "logo", await picture("png"));
        assert.equal((await get(`${new URL(other.body.url).pathname}${url.search}`)).statusCode, 403);
        assert.equal((await get(`/dev/images/..%2F..%2Fpackage.json${url.search}`)).statusCode, 403);
    });

    test("rejects a bad kind, a wrong type, a mislabeled file, and a file over 5 MB", async () => {
        await businessWithProgram(ctx, "img-strict");
        const png = await picture("png");

        const badKind = await uploadImage(ctx, "img-strict", "banner", png);
        assert.deepEqual([badKind.status, badKind.body.error], [400, "invalidImageKind"]);

        const heic = await uploadImage(ctx, "img-strict", "logo", png, "image/heic");
        assert.deepEqual([heic.status, heic.body.error], [415, "unsupportedImageType"]);

        const json = await asPartner(ctx, "img-strict", "POST", "/v1/partner/images?kind=logo", { image: "data" });
        assert.deepEqual([json.status, json.body.error], [415, "unsupportedImageType"]);

        const mislabeled = await uploadImage(ctx, "img-strict", "logo", await picture("webp"), "image/png");
        assert.deepEqual([mislabeled.status, mislabeled.body.error], [415, "unsupportedImageType"]);

        const garbage = await uploadImage(ctx, "img-strict", "logo", Buffer.from("GIF89a nope"), "image/jpeg");
        assert.deepEqual([garbage.status, garbage.body.error], [400, "invalidImage"]);

        const huge = await uploadImage(ctx, "img-strict", "cover", Buffer.alloc(MAX_UPLOAD_BYTES + 1), "image/jpeg");
        assert.deepEqual([huge.status, huge.body.error], [413, "imageTooLarge"]);

        const stored = await ctx.pool.query(
            "SELECT COUNT(*)::int AS count FROM images i JOIN businesses b ON b.id = i.business_id WHERE b.name = 'Cafe img-strict'",
        );
        assert.equal(stored.rows[0].count, 0);
    });
});

describe("logo on the business", () => {
    test("is set, kept, replaced, and removed through PUT /business", async () => {
        await businessWithProgram(ctx, "logo-owner");
        const base = { name: "Logo Cafe", location: "Seattle" };
        const first = await uploadImage(ctx, "logo-owner", "logo", await picture("png"));

        const set = await asPartner(ctx, "logo-owner", "PUT", "/v1/partner/business", { ...base, logoKey: first.body.key });
        assert.equal(set.status, 200);
        assert.equal(set.body.logoKey, first.body.key);
        assert.equal((await download(ctx, set.body.logoURL)).statusCode, 200);

        // Leaving logoKey out changes everything else and keeps the logo.
        const kept = await asPartner(ctx, "logo-owner", "PUT", "/v1/partner/business", { ...base, name: "Logo Cafe 2" });
        assert.deepEqual([kept.body.name, kept.body.logoKey], ["Logo Cafe 2", first.body.key]);

        const second = await uploadImage(ctx, "logo-owner", "logo", await picture("jpeg"), "image/jpeg");
        const replaced = await asPartner(ctx, "logo-owner", "PUT", "/v1/partner/business", { ...base, logoKey: second.body.key });
        assert.equal(replaced.body.logoKey, second.body.key);
        const read = await asPartner(ctx, "logo-owner", "GET", "/v1/partner/business");
        assert.equal(read.body.logoKey, second.body.key);
        assert.equal((await download(ctx, read.body.logoURL)).headers["content-type"], "image/jpeg");

        const removed = await asPartner(ctx, "logo-owner", "PUT", "/v1/partner/business", { ...base, logoKey: null });
        assert.deepEqual([removed.body.logoKey, removed.body.logoURL], [null, null]);
    });

    test("refuses a cover, a made-up key, and another business's logo, and changes nothing", async () => {
        await businessWithProgram(ctx, "logo-a");
        const { businessId: businessB } = await businessWithProgram(ctx, "logo-b");
        const mine = await uploadImage(ctx, "logo-a", "logo", await picture("png"));
        const myCover = await uploadImage(ctx, "logo-a", "cover", await picture("jpeg"), "image/jpeg");
        const theirs = await uploadImage(ctx, "logo-b", "logo", await picture("png"));
        await asPartner(ctx, "logo-a", "PUT", "/v1/partner/business", { name: "A", logoKey: mine.body.key });

        const madeUp = `businesses/${businessB}/logo/${crypto.randomUUID()}.png`;
        for (const logoKey of [myCover.body.key, theirs.body.key, madeUp, "../../etc/passwd", 42, ""]) {
            const response = await asPartner(ctx, "logo-a", "PUT", "/v1/partner/business", { name: "Changed", logoKey });
            assert.deepEqual([response.status, response.body.error], [400, "unknownImage"], String(logoKey));
        }
        const after = await asPartner(ctx, "logo-a", "GET", "/v1/partner/business");
        assert.deepEqual([after.body.name, after.body.logoKey], ["A", mine.body.key]);

        // A brand-new business has no uploads, so a first save with a logo fails and creates nothing.
        const fresh = await asPartner(ctx, "logo-new", "PUT", "/v1/partner/business", { name: "New", logoKey: theirs.body.key });
        assert.equal(fresh.status, 400);
        assert.equal((await asPartner(ctx, "logo-new", "GET", "/v1/partner/business")).status, 404);
    });

    test("the database itself refuses another business's image", async () => {
        const { businessId: a } = await businessWithProgram(ctx, "fk-a");
        await businessWithProgram(ctx, "fk-b");
        const theirs = await uploadImage(ctx, "fk-b", "logo", await picture("png"));
        await assert.rejects(ctx.pool.query("UPDATE businesses SET logo_key = $1 WHERE id = $2", [theirs.body.key, a]), {
            constraint: "businesses_logo_key_fkey",
        });
        await assert.rejects(
            ctx.pool.query(
                `INSERT INTO program_versions (business_id, version, required_punches, reward_description, theme, cover_key)
                 VALUES ($1, 2, 8, 'One drink', $2, $3)`,
                [a, validTheme, theirs.body.key],
            ),
            { constraint: "program_versions_cover_key_fkey" },
        );
    });
});

describe("cover on the card", () => {
    const program = (coverKey?: string | null) => ({
        requiredPunches: 8,
        rewardDescription: "One pastry",
        theme: coverKey === undefined ? validTheme : { ...validTheme, coverKey },
    });
    const publish = (subject: string, coverKey?: string | null) =>
        asPartner(ctx, subject, "POST", "/v1/partner/program/versions", program(coverKey));

    test("is published with a version, and changing only the cover is a change", async () => {
        await businessWithProgram(ctx, "cover-owner");
        const none = await publish("cover-owner");
        assert.equal(none.status, 201);
        assert.deepEqual([none.body.theme.coverKey, none.body.theme.coverURL], [null, null]);

        const cover = await uploadImage(ctx, "cover-owner", "cover", await picture("jpeg", 3000, 2000), "image/jpeg");
        const withCover = await publish("cover-owner", cover.body.key);
        assert.equal(withCover.status, 201);
        assert.equal(withCover.body.theme.coverKey, cover.body.key);
        const image = await download(ctx, withCover.body.theme.coverURL);
        assert.equal(image.statusCode, 200);
        assert.equal((await sharp(image.rawPayload).metadata()).width, 2048);

        const same = await publish("cover-owner", cover.body.key);
        assert.deepEqual([same.status, same.body.error], [409, "unchangedProgram"]);

        const live = await asPartner(ctx, "cover-owner", "GET", "/v1/partner/program");
        assert.equal(live.body.theme.coverKey, cover.body.key);
        assert.equal((await download(ctx, live.body.theme.coverURL)).statusCode, 200);

        // Older versions keep the cover they were published with.
        const removed = await publish("cover-owner", null);
        assert.equal(removed.status, 201);
        const history = await asPartner(ctx, "cover-owner", "GET", "/v1/partner/program/versions");
        assert.deepEqual(
            history.body.versions.map((v: { theme: { coverKey: string | null } }) => v.theme.coverKey),
            [null, cover.body.key, null, null],
        );
        assert.ok(history.body.versions[1].theme.coverURL);
    });

    test("refuses a logo, a made-up key, another business's cover, and a client-set coverURL", async () => {
        await businessWithProgram(ctx, "cover-a");
        const { businessId: businessB } = await businessWithProgram(ctx, "cover-b");
        const myLogo = await uploadImage(ctx, "cover-a", "logo", await picture("png"));
        const theirs = await uploadImage(ctx, "cover-b", "cover", await picture("jpeg"), "image/jpeg");
        const madeUp = `businesses/${businessB}/cover/${crypto.randomUUID()}.jpg`;
        for (const coverKey of [myLogo.body.key, theirs.body.key, madeUp, "nope"]) {
            const response = await publish("cover-a", coverKey);
            assert.deepEqual([response.status, response.body.error], [400, "unknownImage"], coverKey);
        }
        const withURL = await asPartner(ctx, "cover-a", "POST", "/v1/partner/program/versions", {
            ...program(),
            theme: { ...validTheme, coverURL: "https://example.com/cover.jpg" },
        });
        assert.deepEqual([withURL.status, withURL.body.error], [400, "invalidTheme"]);
        const history = await asPartner(ctx, "cover-a", "GET", "/v1/partner/program/versions");
        assert.equal(history.body.versions.length, 1);
    });
});

// Runs against a real storage account when one is configured:
//   AZURE_STORAGE_TEST_ACCOUNT=<account> npm test
// It needs `az login` and the Storage Blob Data Contributor role on the account.
describe("Azure Blob Storage", { skip: !process.env.AZURE_STORAGE_TEST_ACCOUNT && "set AZURE_STORAGE_TEST_ACCOUNT to run" }, () => {
    test("stores privately, serves through an expiring link, and removes", async () => {
        const store = new AzureImageStore({
            account: process.env.AZURE_STORAGE_TEST_ACCOUNT!,
            container: process.env.AZURE_STORAGE_CONTAINER ?? "images",
            urlTtlSeconds: 60,
        });
        const key = `businesses/${crypto.randomUUID()}/logo/${crypto.randomUUID()}.png`;
        const data = await picture("png");
        await store.put(key, data, "image/png");
        try {
            const url = await store.url(key);
            const signed = await fetch(url);
            assert.equal(signed.status, 200);
            assert.equal(signed.headers.get("content-type"), "image/png");
            assert.deepEqual(Buffer.from(await signed.arrayBuffer()), data);

            // Without the signature the container is private.
            const unsigned = await fetch(url.split("?")[0]!);
            assert.ok(unsigned.status >= 400, `unsigned read returned ${unsigned.status}`);
            const tampered = await fetch(url.replace(/sig=[^&]{4}/, "sig=AAAA"));
            assert.equal(tampered.status, 403);
        } finally {
            await store.remove(key);
        }
        assert.equal((await fetch(await store.url(key))).status, 404);
    });
});
