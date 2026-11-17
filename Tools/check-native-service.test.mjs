import assert from "node:assert/strict";
import test from "node:test";
import { checkNativeService, nativeServiceOrigin } from "./check-native-service.mjs";

test("release origin rejects the disposable address that broke installed builds", () => {
    for (const value of [
        undefined, "not a URL", "http://api.example.com", "https://example.invalid",
        "https://localhost", "https://machine.local", "https://api.example.com/path",
        "https://api.example.com?q=x", "https://user:password@api.example.com",
        "https://expired.trycloudflare.com",
    ]) {
        assert.throws(() => nativeServiceOrigin(value));
    }
    assert.equal(nativeServiceOrigin("https://joeyy.example.com/"), "https://joeyy.example.com");
});

test("release checks native readiness without sending any customer credentials", async () => {
    const health = await checkNativeService("https://joeyy.example.com", async (url, options) => {
        assert.equal(url, "https://joeyy.example.com/api/v1/healthz");
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers.Accept, "application/json");
        return Response.json({ status: "ok", factoryKeyTest: true, publicBaseURL: "https://joeyy.example.com" });
    });

    assert.deepEqual(health, { origin: "https://joeyy.example.com", factoryKeyTest: true });
});

test("release refuses a server that signs Wallet passes for a different or missing origin", async () => {
    for (const publicBaseURL of [
        undefined, "https://stale.trycloudflare.com", "https://other.example.com",
        "https://joeyy.example.com/forged-path", "https://joeyy.example.com.attacker.example",
    ]) {
        await assert.rejects(
            checkNativeService("https://joeyy.example.com", async () =>
                Response.json({ status: "ok", factoryKeyTest: true, publicBaseURL })),
            /PUBLIC_BASE_URL must match/,
        );
    }
});

test("a healthy partner-only service is not mistaken for working NFC", async () => {
    await assert.rejects(
        checkNativeService("https://joeyy.example.com", async () => Response.json({ status: "ok" })),
        /partner-only health is insufficient/,
    );
    await assert.rejects(
        checkNativeService("https://joeyy.example.com", async () => new Response(null, { status: 503 })),
        /HTTP 503/,
    );
});

test("no-account builds require explicit server prototype capability", async () => {
    for (const prototypeMode of [undefined, false]) {
        await assert.rejects(checkNativeService("https://joeyy.example.com", async () => Response.json({
            status: "ok", factoryKeyTest: true, publicBaseURL: "https://joeyy.example.com", prototypeMode,
        }), { requirePrototype: true }), /NATIVE_PROTOTYPE_MODE=1/);
    }
    const health = await checkNativeService("https://joeyy.example.com", async () => Response.json({
        status: "ok", factoryKeyTest: true, publicBaseURL: "https://joeyy.example.com", prototypeMode: true,
    }), { requirePrototype: true });
    assert.equal(health.origin, "https://joeyy.example.com");
});
