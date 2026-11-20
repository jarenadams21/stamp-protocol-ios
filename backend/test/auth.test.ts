import assert from "node:assert/strict";
import { test } from "node:test";
import { authFromEnv, generateSigningKey } from "../src/auth.ts";

const live = async () => ({
    AUTH_MODE: "live",
    AUTH_ISSUER: "https://api.joeyy.example",
    AUTH_SIGNING_KEY: JSON.stringify(await generateSigningKey()),
    SIGN_IN_HASH_PEPPER: "p".repeat(32),
    GOOGLE_CLIENT_IDS: "ios.apps.googleusercontent.com, web.apps.googleusercontent.com",
    ACS_EMAIL_ENDPOINT: "https://joeyy-test.communication.azure.com",
    EMAIL_FROM: "DoNotReply@example.azurecomm.net",
});

test("live mode turns on only the methods that are set up", async () => {
    const env = await live();
    const setup = await authFromEnv(env);
    assert.equal(setup.mode, "live");
    assert.equal(setup.signer.config.issuer, "https://api.joeyy.example");
    assert.deepEqual(setup.signIn.methods, ["google", "email"]);
    assert.deepEqual(setup.signIn.google.audiences, ["ios.apps.googleusercontent.com", "web.apps.googleusercontent.com"]);
    assert.deepEqual(setup.signIn.apple.audiences, []);
    assert.equal(setup.signIn.email.label, "Azure Communication Services Email (joeyy-test.communication.azure.com)");

    const all = await authFromEnv({
        ...env,
        APPLE_AUDIENCES: "com.joeyy.customer",
        ACS_ENDPOINT: "https://joeyy-sms.communication.azure.com",
        SMS_FROM: "+18005550100",
    });
    assert.deepEqual(all.signIn.methods, ["apple", "google", "phone", "email"]);
    assert.equal(all.signIn.sms.label, "Azure Communication Services SMS (joeyy-sms.communication.azure.com)");
});

test("SIGN_IN_METHODS chooses methods, and live refuses one that isn't set up", async () => {
    const env = await live();
    assert.deepEqual((await authFromEnv({ ...env, SIGN_IN_METHODS: "email" })).signIn.methods, ["email"]);
    await assert.rejects(authFromEnv({ ...env, SIGN_IN_METHODS: "google,phone" }), /phone/);
    await assert.rejects(authFromEnv({ ...env, SIGN_IN_METHODS: "google,password" }), /unknown method/);
});

test("live mode needs its secrets", async () => {
    const env = await live();
    for (const missing of ["AUTH_ISSUER", "AUTH_SIGNING_KEY", "SIGN_IN_HASH_PEPPER"]) {
        await assert.rejects(authFromEnv({ ...env, [missing]: undefined }), Error, missing);
    }
    await assert.rejects(authFromEnv({ ...env, AUTH_ISSUER: "http://api.joeyy.example" }));
    await assert.rejects(authFromEnv({ ...env, SIGN_IN_HASH_PEPPER: "short" }));
    await assert.rejects(authFromEnv({ ...env, AUTH_SIGNING_KEY: "{}" }));
    // Live is the default, so a missing AUTH_MODE never falls back to dev.
    await assert.rejects(authFromEnv({}));
});

test("dev mode logs codes, is refused in production, and oidc mode is gone", async () => {
    await assert.rejects(authFromEnv({ AUTH_MODE: "dev", NODE_ENV: "production" }));
    await assert.rejects(authFromEnv({ AUTH_MODE: "oidc" }), /removed/);
    const dev = await authFromEnv({ AUTH_MODE: "dev" }, () => {});
    assert.deepEqual(dev.signIn.methods, ["apple", "google", "phone", "email"]);
    assert.equal(dev.signIn.sms.label, "server log (dev SMS)");
    assert.equal(dev.signIn.email.label, "server log (dev email)");

    const devWithEmail = await authFromEnv(
        {
            AUTH_MODE: "dev",
            ACS_EMAIL_ENDPOINT: "https://joeyy-dev-acs.unitedstates.communication.azure.com",
            EMAIL_FROM: "DoNotReply@example.azurecomm.net",
        },
        () => {},
    );
    assert.equal(devWithEmail.signIn.email.label, "Azure Communication Services Email (joeyy-dev-acs.unitedstates.communication.azure.com)");
    assert.equal(devWithEmail.signIn.sms.label, "server log (dev SMS)", "texts still go to the log");
    const halfSet = await authFromEnv({ AUTH_MODE: "dev", ACS_EMAIL_ENDPOINT: "https://joeyy-dev-acs.unitedstates.communication.azure.com" }, () => {});
    assert.equal(halfSet.signIn.email.label, "server log (dev email)");
});
