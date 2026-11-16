import type { NativeCard } from "./src/native/store.ts";
export interface SigningCertificates {
    signerCert: Buffer;
    signerKey: Buffer;
    wwdr: Buffer;
    signerKeyPassphrase?: string;
}
export interface PassSettings {
    baseURL: string;
    passType: string;
    teamID: string;
    certificates: SigningCertificates;
    token: string;
}
export function renderPass(card: NativeCard, settings: PassSettings): Promise<Buffer>;
export function applePush(certificates: SigningCertificates, passType: string): (token: string) => Promise<boolean>;
export class CustomerWallet {
    constructor(options: {
        store: import("./store.mjs").CustomerStore;
        dataDir: string;
        baseURL: string;
        passType: string;
    });
}
