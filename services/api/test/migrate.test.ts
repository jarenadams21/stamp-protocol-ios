import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../src/migrate.ts";

test("npm run migrate recognizes its own script path on macOS, Linux, and Windows", () => {
    const script = path.resolve("src", "migrate.ts");
    const url = pathToFileURL(script).href;
    assert.equal(isMainModule(url, script), true);
    assert.equal(isMainModule(url, path.join("src", "migrate.ts")), true, "relative to the working directory");
    assert.equal(isMainModule(url, path.resolve("test", "migrate.test.ts")), false);
    assert.equal(isMainModule(url, undefined), false);
    if (process.platform === "win32") assert.notEqual(url, `file://${script}`, "the old comparison never matched here");
});
