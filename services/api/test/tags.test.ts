import assert from "node:assert/strict";
import { test } from "node:test";
import { aesCmac, tagsFromEnv, tagVerifier, verifySun } from "../src/tags.ts";

// Stand tag verification (src/tags.ts). No database.

const hex = (text: string) => Buffer.from(text, "hex");

test("AES-CMAC matches RFC 4493's test vectors", () => {
    const key = hex("2b7e151628aed2a6abf7158809cf4f3c");
    assert.equal(aesCmac(key, Buffer.alloc(0)).toString("hex"), "bb1d6929e95937287fa37d129b756746");
    assert.equal(aesCmac(key, hex("6bc1bee22e409f96e93d7e117393172a")).toString("hex"), "070a16b46b4d4144f79bdd9dd04a287c");
    assert.equal(
        aesCmac(key, hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411")).toString("hex"),
        "dfa66747de9ae63030ca32611497c827",
    );
    assert.equal(
        aesCmac(
            key,
            hex(
                "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
            ),
        ).toString("hex"),
        "51f0bebf7e3b9d92fc49741779363cfe",
    );
});

test("SUN verification matches NXP AN12196's example (all-zero keys)", () => {
    const keys = { metaRead: Buffer.alloc(16), fileRead: Buffer.alloc(16) };
    assert.deepEqual(verifySun(keys, "EF963FF7828658A599F3041510671E88", "94EED9EE65337086"), { tagUid: "04DE5F1EACC040", counter: 61 });
    // Any case; a changed MAC, a changed PICCData, or the wrong key proves nothing.
    assert.ok(verifySun(keys, "ef963ff7828658a599f3041510671e88", "94eed9ee65337086"));
    assert.equal(verifySun(keys, "EF963FF7828658A599F3041510671E88", "94EED9EE65337087"), undefined);
    assert.equal(verifySun(keys, "EF963FF7828658A599F3041510671E89", "94EED9EE65337086"), undefined);
    assert.equal(verifySun({ ...keys, fileRead: Buffer.alloc(16, 1) }, "EF963FF7828658A599F3041510671E88", "94EED9EE65337086"), undefined);
    assert.equal(verifySun(keys, "nothex", "94EED9EE65337086"), undefined);
});

test("dev links are accepted only in dev mode", () => {
    assert.deepEqual(tagVerifier("dev").verify("dev-abc.42", "dev"), { tagUid: "dev-abc", counter: 42 });
    assert.equal(tagVerifier("dev").verify("dev-abc.42", ""), undefined);
    assert.equal(tagVerifier("dev").verify("dev abc.42", "dev"), undefined);
    assert.equal(tagVerifier("sun", { metaRead: Buffer.alloc(16), fileRead: Buffer.alloc(16) }).verify("dev-abc.42", "dev"), undefined);
});

test("TAG_MODE settings", () => {
    const zero = "00".repeat(16);
    assert.equal(tagsFromEnv({}).mode, "dev");
    assert.throws(() => tagsFromEnv({ NODE_ENV: "production" }), /SUN_META_READ_KEY/);
    assert.throws(() => tagsFromEnv({ NODE_ENV: "production", TAG_MODE: "dev" }), /not allowed/);
    assert.equal(tagsFromEnv({ NODE_ENV: "production", SUN_META_READ_KEY: zero, SUN_FILE_READ_KEY: zero }).mode, "sun");
    assert.throws(() => tagsFromEnv({ TAG_MODE: "sun", SUN_META_READ_KEY: zero }), /both/);
    assert.throws(() => tagsFromEnv({ SUN_META_READ_KEY: "short", SUN_FILE_READ_KEY: zero }), /32 hex/);
    assert.throws(() => tagsFromEnv({ TAG_MODE: "reader" }), /TAG_MODE/);
    // Dev mode with keys accepts real stands too.
    const both = tagsFromEnv({ SUN_META_READ_KEY: zero, SUN_FILE_READ_KEY: zero });
    assert.ok(both.verify("EF963FF7828658A599F3041510671E88", "94EED9EE65337086"));
    assert.ok(both.verify("dev-1.1", "dev"));
});
