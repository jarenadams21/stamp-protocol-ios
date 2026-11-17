import type pg from "pg";
import type { FastifyBaseLogger } from "fastify";
import { verifyTag } from "../../support.mjs";
import { applePush, renderPass } from "../../wallet.mjs";
import type { NativeConfig } from "./config.ts";
import { NativeStore, type VerifiedTag } from "./store.ts";
import { NativeWallet } from "./wallet.ts";

export interface NativeServices {
    store: NativeStore;
    wallet: NativeWallet;
    verify(url: string): Promise<VerifiedTag>;
    factoryTest: boolean;
    prototypeMode: boolean;
}
export function createNativeServices(pool: pg.Pool, config: NativeConfig): NativeServices {
    const store = new NativeStore(pool, config.prototypeMode);
    const wallet = new NativeWallet(store, {
        baseURL: config.baseURL, passType: config.passType,
        render: (card, token) => renderPass(card, { ...config, token }),
        sendPush: applePush(config.certificates, config.passType),
    });
    return { store, wallet, verify: (url) => verifyTag(config.verifierURL, url), factoryTest: config.factoryTest, prototypeMode: config.prototypeMode };
}
export async function assertNativeReady(pool: pg.Pool) {
    const result = await pool.query("SELECT 1 FROM schema_migrations WHERE version='0004_native_nfc'");
    if (result.rowCount !== 1) throw new Error("Native NFC requires explicit migration 0004_native_nfc; run npm run migrate as the schema owner.");
    const prototype = await pool.query("SELECT 1 FROM schema_migrations WHERE version='0005_native_prototype'");
    if (prototype.rowCount !== 1) throw new Error("Native NFC requires explicit migration 0005_native_prototype; run npm run migrate as the schema owner.");
    await pool.query("SELECT is_prototype FROM native_customers WHERE false");
    const tables = [
        "native_customers", "native_sessions", "native_cafes", "native_tags", "native_cards", "native_events",
        "native_wallet_passes", "native_wallet_devices", "native_wallet_registrations", "native_wallet_jobs",
    ];
    await pool.query(tables.map((table) => `SELECT 1 FROM ${table} WHERE false`).join(" UNION ALL "));
}
export function scheduleNativeWorker(services: NativeServices, log: Pick<FastifyBaseLogger, "warn">, intervalMs = 15_000) {
    let active: Promise<void> | undefined;
    let stopped = false;
    const run = () => {
        if (active || stopped) return;
        active = (async () => {
            await services.wallet.reconcile(() => log.warn("Native Wallet publication failed; durable state retained for retry."));
            const pushes = await services.wallet.flush();
            if (pushes.failed) log.warn("Native Wallet APNs delivery failed; durable jobs retained for retry.");
        })().catch(() => {
            log.warn("Native Wallet worker failed; durable state retained for retry.");
        }).finally(() => { active = undefined; });
    };
    const timer = setInterval(run, intervalMs);
    timer.unref();
    run();
    return {
        async stop() { stopped = true; clearInterval(timer); await active; },
    };
}
