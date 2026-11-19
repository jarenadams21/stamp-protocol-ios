import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { decodeJwt } from "jose";
import { TOKEN_AUDIENCES, verifyBearer } from "../src/auth.ts";
import { verifyIdToken, googleVerifier } from "../src/identity.ts";
import { buildApp } from "../src/app.ts";
import { CODE_MAX_ATTEMPTS, CODE_SENDS_PER_HOUR, SIGN_INS_PER_IP_PER_HOUR, parseEmail, parsePhoneNumber, pruneAuthRecords } from "../src/signIn.ts";
import { setUp, type TestContext } from "./helpers.ts";

let ctx: TestContext;
before(async () => {
    ctx = await setUp();
});
after(async () => {
    await ctx?.close();
});

// Each test signs in from its own address, so the per-IP limit only matters where it's tested.
let nextIp = 1;
const freshIp = () => `10.0.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;

async function post(url: string, body: unknown, ip = freshIp()) {
    const response = await ctx.app.inject({ method: "POST", url, payload: body as object, remoteAddress: ip });
    return { status: response.statusCode, body: response.body ? response.json() : undefined, headers: response.headers };
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const newNonce = () => crypto.randomUUID() + crypto.randomUUID();

async function appleSignIn(role: string, sub: string) {
    const nonce = newNonce();
    const identityToken = await ctx.apple.idToken({ sub, nonce: sha256Hex(nonce) });
    return post("/v1/auth/apple", { role, identityToken, nonce });
}

const partnerBusiness = (token: string) =>
    ctx.app.inject({ method: "GET", url: "/v1/partner/business", headers: { authorization: `Bearer ${token}` } });

describe("Sign in with Apple", () => {
    test("a customer signs in, gets a customer token, and has a customer record", async () => {
        const response = await appleSignIn("customer", "apple-user-1");
        assert.equal(response.status, 200);
        assert.equal(response.body.tokenType, "Bearer");
        assert.equal(response.body.expiresIn, 900);
        assert.match(response.body.refreshToken, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(response.headers["cache-control"], "no-store");

        const claims = decodeJwt(response.body.accessToken);
        assert.equal(claims.aud, TOKEN_AUDIENCES.customer);
        assert.equal(claims.sub, "apple:apple-user-1");
        assert.equal(await verifyBearer(ctx.signer.config, `Bearer ${response.body.accessToken}`, "customer"), "apple:apple-user-1");

        const rows = await ctx.pool.query("SELECT 1 FROM customers WHERE subject = 'apple:apple-user-1'");
        assert.equal(rows.rowCount, 1);
        // Signing in again reuses the same customer.
        assert.equal((await appleSignIn("customer", "apple-user-1")).status, 200);
        assert.equal((await ctx.pool.query("SELECT 1 FROM customers WHERE subject = 'apple:apple-user-1'")).rowCount, 1);
    });

    test("a customer token can't be used as a business owner's, and the other way around", async () => {
        const customer = await appleSignIn("customer", "apple-both");
        const owner = await appleSignIn("partner", "apple-both");
        assert.equal(owner.status, 200);

        // Same Apple ID, two separate accounts: the customer token is refused on partner routes.
        assert.equal((await partnerBusiness(customer.body.accessToken)).statusCode, 401);
        assert.equal((await partnerBusiness(owner.body.accessToken)).statusCode, 404);
        await assert.rejects(verifyBearer(ctx.signer.config, `Bearer ${owner.body.accessToken}`, "customer"));

        // Refreshing keeps each token on its own side.
        const refreshed = await post("/v1/auth/refresh", { refreshToken: customer.body.refreshToken });
        assert.equal(refreshed.status, 200);
        assert.equal(decodeJwt(refreshed.body.accessToken).aud, TOKEN_AUDIENCES.customer);
        assert.equal((await partnerBusiness(refreshed.body.accessToken)).statusCode, 401);
    });

    test("an owner can set up a business with the issued token", async () => {
        const owner = await appleSignIn("partner", "apple-owner");
        const saved = await ctx.app.inject({
            method: "PUT",
            url: "/v1/partner/business",
            headers: { authorization: `Bearer ${owner.body.accessToken}` },
            payload: { name: "Real Cafe", location: "Seattle" },
        });
        assert.equal(saved.statusCode, 201);
        assert.equal((await partnerBusiness(owner.body.accessToken)).statusCode, 200);
    });

    test("rejects a wrong nonce, client, issuer, old token, or forged token", async () => {
        const nonce = newNonce();
        const cases = [
            await ctx.apple.idToken({ sub: "x", nonce: sha256Hex("other-nonce-0000000000") }),
            await ctx.apple.idToken({ sub: "x", nonce }), // raw nonce, not its hash
            await ctx.apple.idToken({ sub: "x", nonce: sha256Hex(nonce), aud: "com.someone.else" }),
            await ctx.apple.idToken({ sub: "x", nonce: sha256Hex(nonce), iss: "https://evil.example" }),
            await ctx.apple.idToken({ sub: "x", nonce: sha256Hex(nonce), iat: Math.floor(Date.now() / 1000) - 20 * 60 }),
            await ctx.apple.idToken({ sub: "x", nonce: sha256Hex(nonce), exp: "-1m" }),
            await ctx.google.idToken({ sub: "x", nonce: sha256Hex(nonce), aud: "com.joeyy.customer", iss: "https://appleid.apple.com" }),
        ];
        for (const identityToken of cases) {
            const response = await post("/v1/auth/apple", { role: "customer", identityToken, nonce });
            assert.equal(response.status, 401);
            assert.equal(response.body.error, "signInFailed");
        }
    });

    test("validates the request", async () => {
        const identityToken = await ctx.apple.idToken({ sub: "x", nonce: "n" });
        assert.equal((await post("/v1/auth/apple", { role: "admin", identityToken, nonce: newNonce() })).body.error, "invalidRole");
        assert.equal((await post("/v1/auth/apple", { role: "customer", identityToken })).body.error, "invalidNonce");
        assert.equal((await post("/v1/auth/apple", { role: "customer", nonce: newNonce() })).body.error, "invalidIdentityToken");
        assert.equal((await post("/v1/auth/apple", [])).body.error, "invalidBody");
    });
});

describe("Google", () => {
    test("signs in with a raw nonce and is a different account from Apple with the same sub", async () => {
        const nonce = newNonce();
        const idToken = await ctx.google.idToken({ sub: "shared-sub", nonce });
        const response = await post("/v1/auth/google", { role: "customer", idToken, nonce });
        assert.equal(response.status, 200);
        assert.equal(decodeJwt(response.body.accessToken).sub, "google:shared-sub");

        const wrongNonce = await post("/v1/auth/google", { role: "customer", idToken, nonce: newNonce() });
        assert.equal(wrongNonce.status, 401);
    });

    test("isn't available until a client ID is configured", async () => {
        const verifier = googleVerifier([], ctx.google.verifier.keys);
        const token = await ctx.google.idToken({ sub: "x", nonce: "n" });
        assert.equal(await verifyIdToken(verifier, token, "n"), undefined);
    });
});

describe("phone number and text code", () => {
    const start = (phoneNumber: string, ip?: string) => post("/v1/auth/phone/start", { phoneNumber }, ip);
    const verify = (phoneNumber: string, code: string | undefined, role = "customer") =>
        post("/v1/auth/phone/verify", { role, phoneNumber, code });

    test("sends a code that signs in once", async () => {
        const started = await start("+1 (206) 555-0101");
        assert.equal(started.status, 202);
        assert.deepEqual(started.body, { expiresIn: 600, resendAfter: 30 });
        const code = ctx.sms.lastCode("+12065550101");
        assert.ok(code);

        const wrong = code === "000000" ? "111111" : "000000";
        assert.equal((await verify("+12065550101", wrong)).body.error, "invalidCode");
        const signedIn = await verify("+12065550101", code);
        assert.equal(signedIn.status, 200);
        const subject = decodeJwt(signedIn.body.accessToken).sub!;
        assert.match(subject, /^phone:[0-9a-f]{64}$/);
        assert.equal(subject.includes("2065550101"), false, "the phone number is never stored or put in tokens");

        assert.equal((await verify("+12065550101", code)).body.error, "invalidCode", "a code works once");
    });

    test("the same phone number is a separate account on each side", async () => {
        await start("+12065550102");
        const customer = await verify("+12065550102", ctx.sms.lastCode("+12065550102"));
        ctx.clockOffsetMs += 31_000;
        await start("+12065550102");
        const owner = await verify("+12065550102", ctx.sms.lastCode("+12065550102"), "partner");
        assert.equal(owner.status, 200);
        assert.equal((await partnerBusiness(customer.body.accessToken)).statusCode, 401);
        assert.equal((await partnerBusiness(owner.body.accessToken)).statusCode, 404);
    });

    test("a code stops working after too many wrong guesses", async () => {
        await start("+12065550103");
        const code = ctx.sms.lastCode("+12065550103")!;
        const wrong = code === "000000" ? "111111" : "000000";
        for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) assert.equal((await verify("+12065550103", wrong)).status, 400);
        assert.equal((await verify("+12065550103", code)).body.error, "invalidCode");
    });

    test("a code expires after 10 minutes", async () => {
        await start("+12065550104");
        const code = ctx.sms.lastCode("+12065550104")!;
        ctx.clockOffsetMs += 10 * 60_000 + 1000;
        assert.equal((await verify("+12065550104", code)).body.error, "invalidCode");
    });

    test("limits resends per number", async () => {
        assert.equal((await start("+12065550105")).status, 202);
        const tooSoon = await start("+12065550105");
        assert.equal(tooSoon.status, 429);
        assert.ok(Number(tooSoon.headers["retry-after"]) > 0);

        for (let i = 1; i < CODE_SENDS_PER_HOUR; i++) {
            ctx.clockOffsetMs += 31_000;
            assert.equal((await start("+12065550105")).status, 202);
        }
        ctx.clockOffsetMs += 31_000;
        assert.equal((await start("+12065550105")).status, 429);
        ctx.clockOffsetMs += 60 * 60_000;
        assert.equal((await start("+12065550105")).status, 202);
    });

    test("a failed text doesn't use up the cooldown", async () => {
        ctx.sms.failing = true;
        try {
            const failed = await start("+12065550106");
            assert.equal(failed.status, 503);
            assert.equal(failed.body.error, "smsUnavailable");
        } finally {
            ctx.sms.failing = false;
        }
        assert.equal((await start("+12065550106")).status, 202);
    });

    test("rejects invalid numbers and countries that aren't enabled", async () => {
        assert.equal((await start("12065550101")).body.error, "invalidPhoneNumber");
        assert.equal((await start("+1206555010")).body.error, "invalidPhoneNumber");
        assert.equal((await start("+33612345678")).body.error, "unsupportedPhoneNumber");
        assert.equal(parsePhoneNumber("+44 7700 900123", ["44"]), "+447700900123");
        assert.equal((await verify("+12065550101", "12345")).body.error, "invalidCode");
    });
});

describe("refresh and sign-out", () => {
    test("rotates refresh tokens and revokes the session when an old one comes back", async () => {
        const signedIn = await appleSignIn("customer", "apple-refresh");
        const first = await post("/v1/auth/refresh", { refreshToken: signedIn.body.refreshToken });
        assert.equal(first.status, 200);
        assert.notEqual(first.body.refreshToken, signedIn.body.refreshToken);

        // The original token was already used: treat it as stolen and revoke the whole session.
        assert.equal((await post("/v1/auth/refresh", { refreshToken: signedIn.body.refreshToken })).status, 401);
        assert.equal((await post("/v1/auth/refresh", { refreshToken: first.body.refreshToken })).status, 401);
    });

    test("sign-out revokes the session", async () => {
        const signedIn = await appleSignIn("partner", "apple-signout");
        assert.equal((await post("/v1/auth/sign-out", { refreshToken: signedIn.body.refreshToken })).status, 204);
        assert.equal((await post("/v1/auth/refresh", { refreshToken: signedIn.body.refreshToken })).status, 401);
        assert.equal((await post("/v1/auth/sign-out", { refreshToken: "nonsense" })).status, 204);
    });

    test("rejects unknown and expired refresh tokens", async () => {
        assert.equal((await post("/v1/auth/refresh", { refreshToken: "x".repeat(43) })).status, 401);
        assert.equal((await post("/v1/auth/refresh", {})).status, 401);
        const signedIn = await appleSignIn("customer", "apple-expired");
        ctx.clockOffsetMs += 61 * 86_400_000;
        try {
            assert.equal((await post("/v1/auth/refresh", { refreshToken: signedIn.body.refreshToken })).status, 401);
            const pruned = await pruneAuthRecords(ctx.pool, new Date(Date.now() + ctx.clockOffsetMs));
            assert.ok(pruned.refreshTokens >= 1);
        } finally {
            ctx.clockOffsetMs -= 61 * 86_400_000;
        }
    });
});

describe("email and one-time code", () => {
    const start = (email: string) => post("/v1/auth/email/start", { email });
    const verify = (email: string, code: string | undefined, role = "customer") => post("/v1/auth/email/verify", { role, email, code });

    test("sends a code to the normalized address that signs in once, without storing the address", async () => {
        const started = await start("  Pat.Owner@Example.COM ");
        assert.equal(started.status, 202);
        assert.deepEqual(started.body, { expiresIn: 600, resendAfter: 30 });
        const code = ctx.email.lastCode("pat.owner@example.com");
        assert.ok(code, "the code goes to the trimmed, lowercased address");
        assert.equal(ctx.sms.lastCode("pat.owner@example.com"), undefined);

        const wrong = code === "000000" ? "111111" : "000000";
        assert.equal((await verify("pat.owner@example.com", wrong)).body.error, "invalidCode");
        const signedIn = await verify("PAT.OWNER@example.com", code);
        assert.equal(signedIn.status, 200);
        const subject = decodeJwt(signedIn.body.accessToken).sub!;
        assert.match(subject, /^email:[0-9a-f]{64}$/);
        assert.equal(subject.includes("example"), false);
        const stored = await ctx.pool.query("SELECT subject FROM customers WHERE subject = $1", [subject]);
        assert.equal(stored.rowCount, 1);
        const leaks = await ctx.pool.query("SELECT 1 FROM auth_codes WHERE target_hash LIKE '%example%'");
        assert.equal(leaks.rowCount, 0);

        assert.equal((await verify("pat.owner@example.com", code)).body.error, "invalidCode", "a code works once");
    });

    test("the same address is a separate account on each side, and tokens stay on their side", async () => {
        await start("both@example.com");
        const customer = await verify("both@example.com", ctx.email.lastCode("both@example.com"));
        ctx.clockOffsetMs += 31_000;
        await start("both@example.com");
        const owner = await verify("both@example.com", ctx.email.lastCode("both@example.com"), "partner");
        assert.equal(owner.status, 200);
        assert.equal(decodeJwt(owner.body.accessToken).aud, TOKEN_AUDIENCES.partner);
        assert.equal((await partnerBusiness(customer.body.accessToken)).statusCode, 401);
        assert.equal((await partnerBusiness(owner.body.accessToken)).statusCode, 404);
        await assert.rejects(verifyBearer(ctx.signer.config, `Bearer ${owner.body.accessToken}`, "customer"));
    });

    test("an email code can't be used as a phone code for the same digits", async () => {
        await start("cross@example.com");
        const code = ctx.email.lastCode("cross@example.com")!;
        const asPhone = await post("/v1/auth/phone/verify", { role: "customer", phoneNumber: "+12065550199", code });
        assert.equal(asPhone.body.error, "invalidCode");
    });

    test("uses the same limits as phone codes", async () => {
        await start("limits@example.com");
        const code = ctx.email.lastCode("limits@example.com")!;
        const wrong = code === "000000" ? "111111" : "000000";
        for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) assert.equal((await verify("limits@example.com", wrong)).status, 400);
        assert.equal((await verify("limits@example.com", code)).body.error, "invalidCode");

        const tooSoon = await start("limits@example.com");
        assert.equal(tooSoon.status, 429);
        for (let i = 1; i < CODE_SENDS_PER_HOUR; i++) {
            ctx.clockOffsetMs += 31_000;
            assert.equal((await start("limits@example.com")).status, 202);
        }
        ctx.clockOffsetMs += 31_000;
        assert.equal((await start("limits@example.com")).status, 429);

        await start("expires@example.com");
        const expiring = ctx.email.lastCode("expires@example.com")!;
        ctx.clockOffsetMs += 10 * 60_000 + 1000;
        assert.equal((await verify("expires@example.com", expiring)).body.error, "invalidCode");
    });

    test("a failed email doesn't use up the cooldown", async () => {
        ctx.email.failing = true;
        try {
            const failed = await start("fails@example.com");
            assert.equal(failed.status, 503);
            assert.equal(failed.body.error, "emailUnavailable");
        } finally {
            ctx.email.failing = false;
        }
        assert.equal((await start("fails@example.com")).status, 202);
    });

    test("rejects invalid addresses", async () => {
        for (const email of ["", "no-at-sign", "a@b", "a b@example.com", `${"x".repeat(65)}@example.com`, 42]) {
            assert.equal((await post("/v1/auth/email/start", { email })).body.error, "invalidEmail");
        }
        assert.equal(parseEmail(" Ünïcode@Example.org "), "ünïcode@example.org");
    });
});

describe("switching sign-in methods on and off", () => {
    test("turned-off methods answer 503 and aren't listed", async () => {
        const app = buildApp({
            pool: ctx.pool,
            auth: ctx.signer.config,
            images: ctx.images,
            signIn: { ...ctx.signInOptions, methods: ["google", "email"] },
        });
        await app.ready();
        try {
            const send = (url: string, payload: object) => app.inject({ method: "POST", url, payload, remoteAddress: freshIp() });
            const methods = await app.inject({ method: "GET", url: "/v1/auth/methods" });
            assert.deepEqual(methods.json(), { methods: ["google", "email"] });

            const nonce = newNonce();
            const identityToken = await ctx.apple.idToken({ sub: "off", nonce: sha256Hex(nonce) });
            const apple = await send("/v1/auth/apple", { role: "customer", identityToken, nonce });
            assert.equal(apple.statusCode, 503);
            assert.equal(apple.json().error, "signInUnavailable");
            assert.equal((await send("/v1/auth/phone/start", { phoneNumber: "+12065550188" })).statusCode, 503);
            assert.equal((await send("/v1/auth/phone/verify", { role: "customer", phoneNumber: "+12065550188", code: "123456" })).statusCode, 503);
            assert.equal(ctx.sms.lastCode("+12065550188"), undefined);
            assert.equal((await send("/v1/auth/email/start", { email: "on@example.com" })).statusCode, 202);
        } finally {
            await app.close();
        }
    });

    test("lists every method that's on", async () => {
        const response = await ctx.app.inject({ method: "GET", url: "/v1/auth/methods" });
        assert.deepEqual(response.json(), { methods: ["apple", "google", "phone", "email"] });
    });
});

describe("sign-in surface", () => {
    test("publishes only the public signing key", async () => {
        const response = await ctx.app.inject({ method: "GET", url: "/.well-known/jwks.json" });
        assert.equal(response.statusCode, 200);
        const [key] = response.json().keys;
        assert.equal(key.kty, "RSA");
        assert.ok(key.kid);
        assert.equal(key.d, undefined);
    });

    test("has no email-and-password sign-in", async () => {
        for (const url of ["/v1/auth/password", "/v1/auth/email", "/v1/auth/sign-up"]) {
            assert.equal((await post(url, { email: "a@b.c", password: "hunter2" })).status, 404);
        }
    });

    test("limits sign-in attempts per IP address", async () => {
        const ip = freshIp();
        let last = 0;
        for (let i = 0; i <= SIGN_INS_PER_IP_PER_HOUR; i++) {
            last = (await post("/v1/auth/refresh", { refreshToken: "x".repeat(43) }, ip)).status;
        }
        assert.equal(last, 429);
    });
});
