import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_ID, CHIP_PATH, checkTapLink, tapLinkOrigin } from "./check-tap-link.mjs";

const good = { applinks: { details: [{ appIDs: [APP_ID], components: [{ "/": CHIP_PATH }] }] } };
const serve = (body, { status = 200, type = "application/json", headers = {} } = {}) => async (url, options) => {
    assert.equal(url, "https://try.example.com/.well-known/apple-app-site-association");
    assert.equal(options.redirect, "manual", "Apple does not follow redirects, so neither does the check");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type, ...headers } });
};

test("only a plain HTTPS origin is accepted", () => {
    for (const value of [undefined, "nope", "http://try.example.com", "https://try.example.com/path", "https://try.example.com?x=1", "https://u:p@try.example.com"]) {
        assert.throws(() => tapLinkOrigin(value));
    }
    assert.equal(tapLinkOrigin("https://try.example.com/"), "https://try.example.com");
});

test("a correct file passes with no warnings", async () => {
    assert.deepEqual(await checkTapLink("https://try.example.com", serve(good)),
        { ok: true, origin: "https://try.example.com", problems: [], warnings: [] });
});

test("the older paths format and a wildcard also count", async () => {
    for (const details of [
        [{ appID: APP_ID, paths: [CHIP_PATH] }],
        [{ appIDs: [APP_ID], paths: ["*"] }],
        [{ appIDs: ["OTHER.app", APP_ID], components: [{ "/": "/tagtt*" }] }],
    ]) {
        assert.equal((await checkTapLink("https://try.example.com", serve({ applinks: { details } }))).ok, true);
    }
});

test("the website's own page in place of the file is explained, not just rejected", async () => {
    const result = await checkTapLink("https://try.example.com", serve("<!doctype html><title>JOEYY</title>", { type: "text/html" }));
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /not valid JSON.*normal web page/);
});

test("redirects and missing files fail, because Apple will not follow or guess", async () => {
    const redirect = await checkTapLink("https://try.example.com", serve("", { status: 301, headers: { location: "https://x.example/" } }));
    assert.match(redirect.problems[0], /redirects \(HTTP 301\)/);
    const missing = await checkTapLink("https://try.example.com", serve("", { status: 404 }));
    assert.match(missing.problems[0], /not served \(HTTP 404\)/);
    const unreachable = await checkTapLink("https://try.example.com", async () => { throw new Error("boom"); });
    assert.equal(unreachable.ok, false);
    assert.match(unreachable.problems[0], /Could not reach/);
});

test("the wrong app, the wrong path, or an excluded path fail", async () => {
    const wrongApp = await checkTapLink("https://try.example.com",
        serve({ applinks: { details: [{ appIDs: ["ABCDE12345.com.other.app"], components: [{ "/": CHIP_PATH }] }] } }));
    assert.match(wrongApp.problems[0], /does not list the app ID/);
    const wrongPath = await checkTapLink("https://try.example.com",
        serve({ applinks: { details: [{ appIDs: [APP_ID], components: [{ "/": "/t" }] }] } }));
    assert.match(wrongPath.problems[0], /not for the chip path/);
    const excluded = await checkTapLink("https://try.example.com",
        serve({ applinks: { details: [{ appIDs: [APP_ID], components: [{ "/": CHIP_PATH, exclude: true }] }] } }));
    assert.equal(excluded.ok, false);
    assert.equal((await checkTapLink("https://try.example.com", serve({}))).ok, false);
});

test("octet-stream works in practice but earns a warning", async () => {
    const result = await checkTapLink("https://try.example.com", serve(good, { type: "application/octet-stream" }));
    assert.equal(result.ok, true);
    assert.match(result.warnings[0], /not application\/json/);
});

test("the file committed for the website passes this check", async () => {
    const committed = JSON.parse(readFileSync(new URL("../../web/public/.well-known/apple-app-site-association", import.meta.url), "utf8"));
    assert.equal((await checkTapLink("https://try.example.com", serve(committed))).ok, true);
});
