import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
    createLocalJWKSet,
    exportJWK,
    generateKeyPair,
    importJWK,
    jwtVerify,
    SignJWT,
    type CryptoKey,
    type JWK,
    type JWTVerifyGetKey,
} from "jose";
import { unauthorized } from "./errors.ts";
import { appleVerifier, googleVerifier } from "./identity.ts";
import { AzureEmailSender, AzureSmsSender, LogCodeSender } from "./senders.ts";
import { SIGN_IN_METHODS, type SignInMethod, type SignInOptions } from "./signIn.ts";

/** The two sides of the app. A token issued for one side is never accepted by the other. */
export type Audience = "partner" | "customer";
export const AUDIENCES: readonly Audience[] = ["partner", "customer"];

/** How the API verifies its own access tokens (spec section 8.5). */
export interface AuthConfig {
    issuer: string;
    audiences: Record<Audience, string>;
    keys: JWTVerifyGetKey;
}

/** Verifies the signature, issuer, audience, and expiry, and returns the token's subject. */
export async function verifyBearer(config: AuthConfig, header: string | undefined, audience: Audience): Promise<string> {
    const match = header?.match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/);
    if (!match?.[1]) throw unauthorized();
    try {
        const { payload } = await jwtVerify(match[1], config.keys, {
            issuer: config.issuer,
            audience: config.audiences[audience],
            algorithms: ["RS256"],
            clockTolerance: 30,
            requiredClaims: ["sub", "exp"],
        });
        if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) throw unauthorized();
        return payload.sub;
    } catch {
        throw unauthorized();
    }
}

// Token signing -----------------------------------------------------------------------------
// The API is its own token issuer: after Apple, Google, or a phone code proves who someone is, it
// signs a short-lived access token for exactly one side. Live, the private key comes from
// AUTH_SIGNING_KEY; AUTH_MODE=dev keeps one in services/api/.dev/ (git-ignored).

export const DEV_ISSUER = "https://joeyy.dev.invalid";
export const TOKEN_AUDIENCES: Record<Audience, string> = { partner: "joeyy-partner", customer: "joeyy-customer" };
/** Kept for tests and scripts written against the dev issuer; the audiences are the same live. */
export const DEV_AUDIENCES = TOKEN_AUDIENCES;
const DEV_KEY_FILE = fileURLToPath(new URL("../.dev/signing-key.json", import.meta.url));

export interface TokenSigner {
    config: AuthConfig;
    /** The public key, served at /.well-known/jwks.json so other services can verify tokens. */
    jwks: { keys: JWK[] };
    sign(audience: Audience, subject: string, expiresIn?: string | number): Promise<string>;
}
/** The dev signer has the same shape; the name is kept for tests and scripts. */
export type DevSigner = TokenSigner;

/** Creates a new RS256 private key as a JWK with a random `kid`. */
export async function generateSigningKey(): Promise<JWK> {
    const pair = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
    return { ...(await exportJWK(pair.privateKey)), kid: crypto.randomUUID(), alg: "RS256", use: "sig" };
}

/** Builds a signer and matching verifier from a private RS256 JWK. */
export async function signerFromJwk(privateJwk: JWK, issuer: string): Promise<TokenSigner> {
    if (privateJwk.kty !== "RSA" || !privateJwk.d || !privateJwk.kid) {
        throw new Error("The signing key must be a private RSA JWK with a kid");
    }
    const { d, p, q, dp, dq, qi, ...publicJwk } = privateJwk;
    const publicKey = { ...publicJwk, alg: "RS256", use: "sig" };
    const privateKey = (await importJWK(privateJwk, "RS256")) as CryptoKey;
    return {
        config: { issuer, audiences: TOKEN_AUDIENCES, keys: createLocalJWKSet({ keys: [publicKey] }) },
        jwks: { keys: [publicKey] },
        sign: (audience, subject, expiresIn = "15m") =>
            new SignJWT({})
                .setProtectedHeader({ alg: "RS256", kid: privateJwk.kid!, typ: "at+jwt" })
                .setIssuer(issuer)
                .setAudience(TOKEN_AUDIENCES[audience])
                .setSubject(subject)
                .setIssuedAt()
                .setJti(crypto.randomUUID())
                .setExpirationTime(typeof expiresIn === "number" ? Math.floor(Date.now() / 1000) + expiresIn : expiresIn)
                .sign(privateKey),
    };
}

/** A signer for the dev issuer. With `persist`, reuses the key in .dev/ so `npm run token` matches the server. */
export async function devSigner(options: { persist: boolean }): Promise<TokenSigner> {
    let privateJwk: JWK | undefined;
    if (options.persist) {
        privateJwk = await readFile(DEV_KEY_FILE, "utf8").then((text) => JSON.parse(text) as JWK, () => undefined);
    }
    if (!privateJwk) {
        privateJwk = await generateSigningKey();
        if (options.persist) {
            await mkdir(new URL("../.dev/", import.meta.url), { recursive: true });
            await writeFile(DEV_KEY_FILE, JSON.stringify(privateJwk), { mode: 0o600 });
        }
    }
    return signerFromJwk(privateJwk, DEV_ISSUER);
}

// Configuration -----------------------------------------------------------------------------

export interface AuthSetup {
    signer: TokenSigner;
    signIn: SignInOptions;
    mode: "live" | "dev";
}

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/**
 * Builds token signing and sign-in from the environment.
 *
 * - `AUTH_MODE=live`: AUTH_ISSUER, AUTH_SIGNING_KEY, and SIGN_IN_HASH_PEPPER are required. Each
 *   sign-in method needs its own settings: APPLE_AUDIENCES, GOOGLE_CLIENT_IDS, ACS_ENDPOINT and
 *   SMS_FROM (phone), and ACS_EMAIL_ENDPOINT and EMAIL_FROM (email).
 * - `AUTH_MODE=dev`: a local key, a fixed pepper, and codes written to the log unless the Azure
 *   settings are present. Refused when NODE_ENV=production.
 *
 * SIGN_IN_METHODS (for example "google,email") chooses which methods are on. Unset, live turns on
 * every method that has its settings and dev turns on all of them. Live refuses to start with a
 * method turned on but not set up.
 */
export async function authFromEnv(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.warn): Promise<AuthSetup> {
    const mode = env.AUTH_MODE ?? "live";
    if (mode === "oidc") throw new Error('AUTH_MODE=oidc was removed; the API now issues its own tokens. Use "live" or "dev".');
    if (mode !== "live" && mode !== "dev") throw new Error(`AUTH_MODE must be "live" or "dev", not "${mode}"`);
    if (mode === "dev" && env.NODE_ENV === "production") throw new Error("AUTH_MODE=dev is not allowed when NODE_ENV=production");
    const live = mode === "live";

    let signer: TokenSigner;
    let pepper: string;
    if (live) {
        const { AUTH_ISSUER, AUTH_SIGNING_KEY, SIGN_IN_HASH_PEPPER } = env;
        if (!AUTH_ISSUER || !AUTH_SIGNING_KEY || !SIGN_IN_HASH_PEPPER) {
            throw new Error("AUTH_MODE=live needs AUTH_ISSUER, AUTH_SIGNING_KEY, and SIGN_IN_HASH_PEPPER");
        }
        if (!AUTH_ISSUER.startsWith("https://")) throw new Error("AUTH_ISSUER must be an https:// URL");
        if (SIGN_IN_HASH_PEPPER.length < 32) throw new Error("SIGN_IN_HASH_PEPPER must be at least 32 characters");
        let jwk: JWK;
        try {
            jwk = JSON.parse(AUTH_SIGNING_KEY) as JWK;
        } catch {
            throw new Error("AUTH_SIGNING_KEY must be a private JWK in JSON (see `npm run auth:key`)");
        }
        signer = await signerFromJwk(jwk, AUTH_ISSUER);
        pepper = SIGN_IN_HASH_PEPPER;
    } else {
        signer = await devSigner({ persist: true });
        pepper = env.SIGN_IN_HASH_PEPPER ?? "joeyy-dev-sign-in-pepper-not-secret-0";
    }

    const appleAudiences = env.APPLE_AUDIENCES === undefined ? (live ? [] : ["com.joeyy.customer"]) : list(env.APPLE_AUDIENCES);
    const googleClientIds = list(env.GOOGLE_CLIENT_IDS);
    const emailEndpoint = env.ACS_EMAIL_ENDPOINT ?? env.ACS_ENDPOINT;
    const configured: Record<SignInMethod, boolean> = {
        apple: appleAudiences.length > 0,
        google: googleClientIds.length > 0,
        phone: !live || Boolean(env.ACS_ENDPOINT && env.SMS_FROM),
        email: !live || Boolean(emailEndpoint && env.EMAIL_FROM),
    };

    let methods: SignInMethod[];
    if (env.SIGN_IN_METHODS === undefined) {
        methods = SIGN_IN_METHODS.filter((method) => configured[method] || (!live && method === "google"));
    } else {
        methods = [];
        for (const name of list(env.SIGN_IN_METHODS)) {
            if (!(SIGN_IN_METHODS as readonly string[]).includes(name)) {
                throw new Error(`SIGN_IN_METHODS: unknown method "${name}" (use ${SIGN_IN_METHODS.join(", ")})`);
            }
            const method = name as SignInMethod;
            if (live && !configured[method]) throw new Error(`SIGN_IN_METHODS includes ${method}, but its settings are missing`);
            if (!methods.includes(method)) methods.push(method);
        }
    }

    const useAzureSms = methods.includes("phone") && Boolean(env.ACS_ENDPOINT && env.SMS_FROM);
    const useAzureEmail = methods.includes("email") && Boolean(emailEndpoint && env.EMAIL_FROM);
    return {
        mode,
        signer,
        signIn: {
            signer,
            methods,
            apple: appleVerifier(appleAudiences),
            google: googleVerifier(googleClientIds),
            sms: useAzureSms ? new AzureSmsSender({ endpoint: env.ACS_ENDPOINT!, from: env.SMS_FROM! }) : new LogCodeSender("SMS", log),
            email: useAzureEmail ? new AzureEmailSender({ endpoint: emailEndpoint!, from: env.EMAIL_FROM! }) : new LogCodeSender("email", log),
            hashPepper: pepper,
            phoneCountryCodes: env.PHONE_COUNTRY_CODES === undefined ? ["1"] : list(env.PHONE_COUNTRY_CODES),
        },
    };
}