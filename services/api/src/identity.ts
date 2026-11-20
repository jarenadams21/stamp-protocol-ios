import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Checks an ID token from Apple or Google. The app gets the token from the provider and sends it
 * once; the API verifies it and then issues its own tokens. Provider tokens are never accepted on
 * other routes.
 */
export interface IdTokenVerifier {
    provider: "apple" | "google";
    issuers: string[];
    /** Client IDs this backend accepts: the iOS bundle or client ID, and later the website's. */
    audiences: string[];
    keys: JWTVerifyGetKey;
    /** How the token's `nonce` claim relates to the nonce the app sends to the API. */
    nonceClaim(nonce: string): string;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Sign in with Apple. The app asks Apple for a token with SHA-256(nonce) and sends the raw nonce,
 * Apple's documented pattern, so a token can't be replayed without its nonce.
 */
export function appleVerifier(audiences: string[], keys?: JWTVerifyGetKey): IdTokenVerifier {
    return {
        provider: "apple",
        issuers: ["https://appleid.apple.com"],
        audiences,
        keys: keys ?? createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
        nonceClaim: sha256Hex,
    };
}

/** Google. The app puts the nonce in the authorization request, and Google copies it into the token. */
export function googleVerifier(audiences: string[], keys?: JWTVerifyGetKey): IdTokenVerifier {
    return {
        provider: "google",
        issuers: ["https://accounts.google.com", "accounts.google.com"],
        audiences,
        keys: keys ?? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
        nonceClaim: (nonce) => nonce,
    };
}

/**
 * Returns the provider's stable user ID, or undefined when the token is invalid, expired, older
 * than ten minutes, for another client, or doesn't carry the nonce.
 */
export async function verifyIdToken(verifier: IdTokenVerifier, token: string, nonce: string): Promise<string | undefined> {
    if (verifier.audiences.length === 0) return undefined;
    try {
        const { payload } = await jwtVerify(token, verifier.keys, {
            issuer: verifier.issuers,
            audience: verifier.audiences,
            algorithms: ["RS256"],
            clockTolerance: 30,
            maxTokenAge: "10m",
            requiredClaims: ["sub", "exp", "iat", "nonce"],
        });
        if (payload.nonce !== verifier.nonceClaim(nonce)) return undefined;
        if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 200) return undefined;
        return payload.sub;
    } catch {
        return undefined;
    }
}
