import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
    createLocalJWKSet,
    createRemoteJWKSet,
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

export type Audience = "partner" | "customer";

/** How the API verifies bearer tokens. There is no separate auth service (spec section 2). */
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

// Development tokens ------------------------------------------------------------------------
// Until the identity provider is set up, AUTH_MODE=dev verifies tokens signed by a key pair kept in
// backend/.dev/ (git-ignored). `npm run token` mints them. Never enabled in production.

export const DEV_ISSUER = "https://joeyy.dev.invalid";
export const DEV_AUDIENCES: Record<Audience, string> = { partner: "joeyy-partner-dev", customer: "joeyy-customer-dev" };
const DEV_KEY_FILE = fileURLToPath(new URL("../.dev/signing-key.json", import.meta.url));

export interface DevSigner {
    config: AuthConfig;
    sign(audience: Audience, subject: string, expiresIn?: string): Promise<string>;
}

/** Creates a signer and matching verifier from a key pair. With `persist`, reuses the key in .dev/. */
export async function devSigner(options: { persist: boolean }): Promise<DevSigner> {
    let privateJwk: JWK | undefined;
    if (options.persist) {
        privateJwk = await readFile(DEV_KEY_FILE, "utf8").then((text) => JSON.parse(text) as JWK, () => undefined);
    }
    if (!privateJwk) {
        const pair = await generateKeyPair("RS256", { extractable: true });
        privateJwk = { ...(await exportJWK(pair.privateKey)), kid: crypto.randomUUID(), alg: "RS256" };
        if (options.persist) {
            await mkdir(new URL("../.dev/", import.meta.url), { recursive: true });
            await writeFile(DEV_KEY_FILE, JSON.stringify(privateJwk), { mode: 0o600 });
        }
    }
    const { d, p, q, dp, dq, qi, ...publicJwk } = privateJwk;
    const privateKey = (await importJWK(privateJwk, "RS256")) as CryptoKey;
    return {
        config: { issuer: DEV_ISSUER, audiences: DEV_AUDIENCES, keys: createLocalJWKSet({ keys: [publicJwk] }) },
        sign: (audience, subject, expiresIn = "1h") =>
            new SignJWT({})
                .setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
                .setIssuer(DEV_ISSUER)
                .setAudience(DEV_AUDIENCES[audience])
                .setSubject(subject)
                .setIssuedAt()
                .setExpirationTime(expiresIn)
                .sign(privateKey),
    };
}

/** Builds the auth configuration from AUTH_MODE and the OIDC_* settings. */
export async function authFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<AuthConfig> {
    const mode = env.AUTH_MODE ?? "oidc";
    if (mode === "dev") {
        if (env.NODE_ENV === "production") throw new Error("AUTH_MODE=dev is not allowed when NODE_ENV=production");
        return (await devSigner({ persist: true })).config;
    }
    if (mode !== "oidc") throw new Error(`AUTH_MODE must be "oidc" or "dev", not "${mode}"`);
    const { OIDC_ISSUER, OIDC_JWKS_URI, PARTNER_AUDIENCE, CUSTOMER_AUDIENCE } = env;
    if (!OIDC_ISSUER || !OIDC_JWKS_URI || !PARTNER_AUDIENCE || !CUSTOMER_AUDIENCE) {
        throw new Error("AUTH_MODE=oidc needs OIDC_ISSUER, OIDC_JWKS_URI, PARTNER_AUDIENCE, and CUSTOMER_AUDIENCE");
    }
    return {
        issuer: OIDC_ISSUER,
        audiences: { partner: PARTNER_AUDIENCE, customer: CUSTOMER_AUDIENCE },
        keys: createRemoteJWKSet(new URL(OIDC_JWKS_URI)),
    };
}
