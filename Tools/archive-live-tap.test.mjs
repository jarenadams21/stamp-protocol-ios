import assert from "node:assert/strict";
import test from "node:test";
import { archiveLiveTap } from "./archive-live-tap.mjs";

test("archive pins the checked service origin instead of an old local build setting", async () => {
    let runs = 0;
    const result = await archiveLiveTap("https://joeyy.example.com/", {
        request: async () => Response.json({
            status: "ok", factoryKeyTest: true, publicBaseURL: "https://joeyy.example.com",
        }),
        run: (command, args, options) => {
            runs++;
            assert.equal(command, "xcodebuild");
            assert.ok(args.includes("LOYALTY_API_BASE_URL=https://joeyy.example.com"));
            assert.ok(args.includes("LOYALTY_PROTOTYPE_MODE=NO"));
            assert.ok(args.includes("Release"));
            assert.equal(options.shell, false);
            return { status: 0 };
        },
    });

    assert.equal(runs, 1);
    assert.equal(result.origin, "https://joeyy.example.com");
});

test("prototype archives pin no-account mode only after checking server capability", async () => {
    let runs = 0;
    const run = (_command, args) => {
        runs++;
        assert.ok(args.includes("LOYALTY_PROTOTYPE_MODE=YES"));
        return { status: 0 };
    };
    const request = async () => Response.json({
        status: "ok", factoryKeyTest: true, publicBaseURL: "https://joeyy.example.com", prototypeMode: true,
    });
    const result = await archiveLiveTap("https://joeyy.example.com", { prototypeMode: true, request, run });
    assert.equal(result.prototypeMode, true);
    await assert.rejects(archiveLiveTap("https://joeyy.example.com", {
        prototypeMode: true, run, request: async () => Response.json({
            status: "ok", factoryKeyTest: true, publicBaseURL: "https://joeyy.example.com", prototypeMode: false,
        }),
    }), /NATIVE_PROTOTYPE_MODE=1/);
    assert.equal(runs, 1);
});

test("unready or disposable endpoints cannot produce an apparently shippable archive", async () => {
    let runs = 0;
    const run = () => { runs++; return { status: 0 }; };
    await assert.rejects(
        archiveLiveTap("https://expired.trycloudflare.com", { run }),
        /disposable/,
    );
    await assert.rejects(
        archiveLiveTap("https://joeyy.example.com", {
            run, request: async () => new Response(null, { status: 503 }),
        }),
        /HTTP 503/,
    );
    await assert.rejects(
        archiveLiveTap("https://joeyy.example.com", {
            run, request: async () => Response.json({
                status: "ok", factoryKeyTest: true, publicBaseURL: "https://stale.example.com",
            }),
        }),
        /PUBLIC_BASE_URL must match/,
    );
    assert.equal(runs, 0);
});
