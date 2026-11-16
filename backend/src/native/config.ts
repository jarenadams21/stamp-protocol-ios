import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type { SigningCertificates } from "../../wallet.mjs";

export interface NativeConfig {
    baseURL: string;
    verifierURL: string;
    passType: string;
    teamID: string;
    factoryTest: boolean;
    certificates: SigningCertificates;
}
function required(env: NodeJS.ProcessEnv, key: string) {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Native NFC requires ${key}.`);
    return value;
}
function serviceURL(value: string, setting: string) {
    try { return new URL(value); }
    catch { throw new Error(`Native NFC requires a valid ${setting}.`); }
}
function privateHTTPHost(hostname: string) {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1" || host.endsWith(".internal") || host.endsWith(".local")) return true;
    if (!host.includes(".") && !host.includes(":") && !isIP(host)) return true; // private container service name
    const parts = host.split(".").map(Number);
    return isIP(host) === 4 && (parts[0] === 127 || parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31));
}
export async function nativeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<NativeConfig | undefined> {
    if (env.NATIVE_NFC_ENABLED !== undefined && !["0", "1"].includes(env.NATIVE_NFC_ENABLED)) {
        throw new Error("NATIVE_NFC_ENABLED must be 0 or 1.");
    }
    if (env.NATIVE_NFC_ENABLED !== "1") return undefined;
    const baseURL = required(env, "PUBLIC_BASE_URL").replace(/\/$/, "");
    const origin = serviceURL(baseURL, "PUBLIC_BASE_URL");
    if (origin.protocol !== "https:" || origin.origin !== baseURL) throw new Error("Native NFC requires PUBLIC_BASE_URL to be an HTTPS origin.");
    const verifierURL = required(env, "SDM_BACKEND_URL");
    const verifier = serviceURL(verifierURL, "SDM_BACKEND_URL");
    if (!["http:", "https:"].includes(verifier.protocol) || verifier.username || verifier.password ||
        verifier.search || verifier.hash || verifier.pathname !== "/" ||
        (verifier.protocol === "http:" && !privateHTTPHost(verifier.hostname))) {
        throw new Error("SDM_BACKEND_URL must be a private HTTP or authenticated-network HTTPS service origin, without URL credentials.");
    }
    const mode = required(env, "NATIVE_NFC_KEY_MODE");
    if (!["provisioned", "factory-test"].includes(mode) || (mode === "factory-test" && env.FACTORY_KEY_TEST !== "1") ||
        (mode === "provisioned" && env.FACTORY_KEY_TEST === "1")) {
        throw new Error("Select NATIVE_NFC_KEY_MODE=provisioned, or factory-test with explicit FACTORY_KEY_TEST=1.");
    }
    const passType = required(env, "PASS_TYPE_ID"), teamID = required(env, "TEAM_ID");
    if (!/^pass\.[a-zA-Z0-9.-]+$/.test(passType) || !/^[A-Z0-9]{10}$/.test(teamID)) {
        throw new Error("Configure a valid PASS_TYPE_ID and 10-character TEAM_ID.");
    }
    const paths = ["SIGNER_CERT_PATH", "SIGNER_KEY_PATH", "WWDR_CERT_PATH"].map((key) => ({ key, path: required(env, key) }));
    const buffers = await Promise.all(paths.map(async ({ key, path }) => {
        try { return await readFile(path); }
        catch { throw new Error(`Native NFC could not read ${key}.`); }
    }));
    const [signerCert, signerKey, wwdr] = buffers;
    if (!signerCert || !signerKey || !wwdr) throw new Error("Native NFC signing certificates are missing.");
    const certificates: SigningCertificates = {
        signerCert, signerKey, wwdr,
        ...(env.SIGNER_KEY_PASSPHRASE ? { signerKeyPassphrase: env.SIGNER_KEY_PASSPHRASE } : {}),
    };
    try {
        const cert = new X509Certificate(signerCert);
        new X509Certificate(wwdr);
        const key = createPrivateKey({ key: signerKey, passphrase: certificates.signerKeyPassphrase });
        if (!cert.checkPrivateKey(key) || Date.parse(cert.validTo) <= Date.now()) throw new Error("Invalid signing identity");
    } catch { throw new Error("Native NFC signing identity is invalid, expired, or its key/passphrase does not match."); }
    return { baseURL, verifierURL, passType, teamID, factoryTest: mode === "factory-test", certificates };
}
