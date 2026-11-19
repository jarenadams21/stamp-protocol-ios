import assert from "node:assert/strict";
import { test } from "node:test";
import { authFromEnv, generateSigningKey } from "../src/auth.ts";

const live = async () => ({
    AUTH_MODE: "live",
    AUTH_ISSUER: "https://api.joeyy.example",
    AUTH_SIGNING_KEY: JSON.stringify(await generateSigningKey()),
    PHONE_HASH_PEPPER: "p".repeat(32),
    ACS_ENDPOINT: "https://joeyy-test.communication.azure.com",
    SMS_FROM: "+18005550100",
    GOOGLE_CLIENT_IDS: "ios.apps.googleusercontent.com, web.apps.googleusercontent.com",
});

test("live mode needs its secrets and issues tokens with its own issuer", async () => {
    const env = await live();
    const setup = await authFromEnv(env);
    assert.equal(setup.mode, "live");
    assert.equal(setup.signer.config.issuer, "https://api.joeyy.example");
    assert.deepEqual(setup.signIn.google.audiences, ["ios.apps.googleusercontent.com", "web.apps.googleusercontent.com"]);
    assert.deepEqual(setup.signIn.apple.audiences, ["com.joeyy.customer"]);
    assert.equal(setup.signIn.sms.label, "Azure Communication Services (joeyy-test.communication.azure.com)");

    for (const missing of ["AUTH_ISSUER", "AUTH_SIGNING_KEY", "PHONE_HASH_PEPPER", "ACS_ENDPOINT", "SMS_FROM"]) {
        await assert.rejects(authFromEnv({ ...env, [missing]: undefined }), Error, missing);
    }
    await assert.rejects(authFromEnv({ ...env, AUTH_ISSUER: "http://api.joeyy.example" }));
    await assert.rejects(authFromEnv({ ...env, PHONE_HASH_PEPPER: "short" }));
    await assert.rejects(authFromEnv({ ...env, AUTH_SIGNING_KEY: "{}" }));
    // Live is the default, so a missing AUTH_MODE never falls back to dev.
    await assert.rejects(authFromEnv({}));
});

test("dev mode is refused in production, and oidc mode is gone", async () => {
    await assert.rejects(authFromEnv({ AUTH_MODE: "dev", NODE_ENV: "production" }));
    await assert.rejects(authFromEnv({ AUTH_MODE: "oidc" }), /removed/);
    const dev = await authFromEnv({ AUTH_MODE: "dev" }, () => {});
    assert.equal(dev.signIn.sms.label, "server log (dev)");
});
