import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkNativeService } from "./check-native-service.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function archiveLiveTap(origin, {
    request = fetch,
    run = spawnSync,
    archivePath = resolve(root, ".build/native-release/JOEYY.xcarchive"),
} = {}) {
    const health = await checkNativeService(origin, request);
    await mkdir(dirname(archivePath), { recursive: true });
    const args = [
        "-project", "JOEYY.xcodeproj", "-scheme", "JOEYY",
        "-configuration", "Release", "-destination", "generic/platform=iOS",
        "-archivePath", archivePath,
        "-derivedDataPath", resolve(root, ".build/native-release/DerivedData"),
        "-jobs", "1", "-allowProvisioningUpdates", "archive",
        "CODE_SIGN_STYLE=Automatic", "COMPILER_INDEX_STORE_ENABLE=NO",
        "OTHER_SWIFT_FLAGS=$(inherited) -j1",
        `LOYALTY_API_BASE_URL=${health.origin}`,
    ];
    const result = run("xcodebuild", args, { cwd: root, stdio: "inherit", shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`The signed archive failed (exit ${result.status ?? "unknown"}).`);
    return { archivePath, ...health };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const result = await archiveLiveTap(process.argv[2]);
        console.log(`Signed native Tap archive: ${result.archivePath}`);
        if (result.factoryKeyTest) console.log("Hardware-test service only; factory-key tags are not valid for valuable rewards.");
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Native Tap archive failed.");
        process.exitCode = 1;
    }
}
