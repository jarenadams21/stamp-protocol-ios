import { createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

// Stand tags (docs/web-connect.md, decision 4). A stand is an NTAG 424 DNA chip that writes a fresh
// SUN ("Secure Unique NFC") message into its link on every read: `picc` is the chip's UID and read
// counter, AES-encrypted, and `cmac` is a MAC over them, so a link can't be forged or edited. The
// counter goes up on every read; the tap route accepts each counter once (replay protection), which
// is what stops a saved or shared link from stamping twice.
//
// Verification follows NXP AN12196 ("NTAG 424 DNA and NTAG 424 DNA TagTamper features and hints"),
// section "SUN message with encrypted PICCData and CMAC":
//
//   1. PICCData = AES-128-CBC-decrypt(K_SDMMetaRead, IV = 0, picc). Byte 0 is the PICCDataTag
//      (bit 7: UID mirrored, bit 6: counter mirrored, low nibble: UID length, 7). Then UID (7
//      bytes) and SDMReadCtr (3 bytes, little-endian).
//   2. SV2 = 3C C3 00 01 00 80 || UID || SDMReadCtr, and K_SesSDMFileReadMAC = CMAC(K_SDMFileRead, SV2).
//   3. The tag's MAC is CMAC(K_SesSDMFileReadMAC, MAC input) truncated to its odd-indexed bytes
//      (S1, S3, ... S15). With the cmac parameter straight after picc, the MAC input is empty.
//
// Keys come from the environment and are the same for every stand for now. Per-tag keys (AN10922
// diversification from the UID) are a phase 2 change inside `fileReadKey`.

export type TagMode = "dev" | "sun";

export interface VerifiedTap {
    /** The chip's UID as uppercase hex, or the dev tag's name. Matches `readers.tag_uid`. */
    tagUid: string;
    counter: number;
}

export interface TagVerifier {
    readonly mode: TagMode;
    /** The tag and counter a tap link proves, or undefined when it proves nothing. */
    verify(picc: unknown, cmac: unknown): VerifiedTap | undefined;
}

export interface SunKeys {
    /** K_SDMMetaRead: decrypts PICCData. */
    metaRead: Buffer;
    /** K_SDMFileRead: derives the session MAC key. */
    fileRead: Buffer;
}

const ZERO_IV = Buffer.alloc(16);

function aesEcbBlock(key: Buffer, block: Buffer): Buffer {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** Doubling in GF(2^128), for the CMAC subkeys (RFC 4493 section 2.3). */
function double(block: Buffer): Buffer {
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) out[i] = ((block[i]! << 1) | (i < 15 ? block[i + 1]! >> 7 : 0)) & 0xff;
    if (block[0]! & 0x80) out[15]! ^= 0x87;
    return out;
}

/** AES-128-CMAC (RFC 4493). Node has no CMAC of its own. */
export function aesCmac(key: Buffer, message: Buffer): Buffer {
    const k1 = double(aesEcbBlock(key, Buffer.alloc(16)));
    const k2 = double(k1);
    const blocks = Math.max(1, Math.ceil(message.length / 16));
    const complete = message.length > 0 && message.length % 16 === 0;
    const last = Buffer.alloc(16);
    message.copy(last, 0, (blocks - 1) * 16);
    if (!complete) last[message.length - (blocks - 1) * 16] = 0x80;
    const subkey = complete ? k1 : k2;
    for (let i = 0; i < 16; i++) last[i]! ^= subkey[i]!;
    let state: Buffer = Buffer.alloc(16);
    for (let b = 0; b < blocks - 1; b++) {
        const block = message.subarray(b * 16, b * 16 + 16);
        for (let i = 0; i < 16; i++) state[i]! ^= block[i]!;
        state = aesEcbBlock(key, state);
    }
    for (let i = 0; i < 16; i++) state[i]! ^= last[i]!;
    return aesEcbBlock(key, state);
}

/** Verifies an NTAG 424 DNA SUN message (AN12196). Hex in, any case. */
export function verifySun(keys: SunKeys, piccHex: string, cmacHex: string): VerifiedTap | undefined {
    if (!/^[0-9a-f]{32}$/i.test(piccHex) || !/^[0-9a-f]{16}$/i.test(cmacHex)) return undefined;
    const decipher = createDecipheriv("aes-128-cbc", keys.metaRead, ZERO_IV);
    decipher.setAutoPadding(false);
    const picc = Buffer.concat([decipher.update(Buffer.from(piccHex, "hex")), decipher.final()]);
    // UID and counter both mirrored, and a 7-byte UID: the only layout a JOEYY stand is set up with.
    if ((picc[0]! & 0xc0) !== 0xc0 || (picc[0]! & 0x0f) !== 7) return undefined;
    const uid = picc.subarray(1, 8);
    const counterBytes = picc.subarray(8, 11);
    const sv2 = Buffer.concat([Buffer.from("3cc300010080", "hex"), uid, counterBytes]);
    const sessionKey = aesCmac(keys.fileRead, sv2);
    const full = aesCmac(sessionKey, Buffer.alloc(0));
    const expected = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]!));
    if (!timingSafeEqual(expected, Buffer.from(cmacHex, "hex"))) return undefined;
    return { tagUid: uid.toString("hex").toUpperCase(), counter: counterBytes.readUIntLE(0, 3) };
}

/** A dev tag link: `picc = "<tag uid>.<counter>"`, any non-empty cmac. No hardware needed. */
const DEV_PICC = /^([A-Za-z0-9-]{1,64})\.(\d{1,15})$/;

export function tagVerifier(mode: TagMode, keys?: SunKeys): TagVerifier {
    return {
        mode,
        verify(picc, cmac) {
            if (typeof picc !== "string" || typeof cmac !== "string" || !cmac) return undefined;
            if (mode === "dev") {
                const match = picc.match(DEV_PICC);
                if (match) return { tagUid: match[1]!, counter: Number(match[2]) };
            }
            // Dev mode also accepts real stands when keys are set, so hardware can be tried locally.
            return keys ? verifySun(keys, picc, cmac) : undefined;
        },
    };
}

function hexKey(value: string | undefined, name: string): Buffer | undefined {
    if (value === undefined || value === "") return undefined;
    if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error(`${name} must be 32 hex characters (an AES-128 key)`);
    return Buffer.from(value, "hex");
}

/**
 * TAG_MODE: "sun" verifies real stands only and needs SUN_META_READ_KEY and SUN_FILE_READ_KEY.
 * "dev" (the default outside production) also accepts `<tag uid>.<counter>` links. Dev is refused
 * when NODE_ENV=production, because a dev link can be typed by anyone.
 */
export function tagsFromEnv(env: NodeJS.ProcessEnv = process.env): TagVerifier {
    const mode = env.TAG_MODE ?? (env.NODE_ENV === "production" ? "sun" : "dev");
    if (mode !== "dev" && mode !== "sun") throw new Error(`TAG_MODE must be "dev" or "sun", not "${mode}"`);
    if (mode === "dev" && env.NODE_ENV === "production") throw new Error("TAG_MODE=dev is not allowed when NODE_ENV=production");
    const metaRead = hexKey(env.SUN_META_READ_KEY, "SUN_META_READ_KEY");
    const fileRead = hexKey(env.SUN_FILE_READ_KEY, "SUN_FILE_READ_KEY");
    if (Boolean(metaRead) !== Boolean(fileRead)) throw new Error("Set both SUN_META_READ_KEY and SUN_FILE_READ_KEY, or neither");
    if (mode === "sun" && !metaRead) throw new Error("TAG_MODE=sun needs SUN_META_READ_KEY and SUN_FILE_READ_KEY");
    return tagVerifier(mode, metaRead && fileRead ? { metaRead, fileRead } : undefined);
}
