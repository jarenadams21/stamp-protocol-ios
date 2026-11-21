#!/bin/bash
# Picks an iPhone simulator, boots it while the app builds, and builds for testing.
# Run from apps/ios. Writes udid=<id> to $GITHUB_OUTPUT. Exits non-zero only if the build fails.
set -uo pipefail

UDID=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
for runtime in sorted(devices, reverse=True):
    if "iOS" not in runtime:
        continue
    for device in devices[runtime]:
        if device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
sys.exit("No available iPhone simulator")
')
[ -n "$UDID" ] || exit 1
echo "udid=$UDID" >> "${GITHUB_OUTPUT:-/dev/null}"

# First boot of a fresh simulator takes a minute or two; overlap it with the build.
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b > bootstatus.log 2>&1 &
BOOT_PID=$!

SECONDS=0
xcodebuild build-for-testing -project JOEYY.xcodeproj -scheme JOEYY \
  -destination "id=$UDID" -derivedDataPath DerivedData \
  COMPILER_INDEX_STORE_ENABLE=NO > build.log 2>&1
status=$?
grep -E "error:|warning: .*(Swift 6|concurren|Sendable)|\*\* " build.log | head -80
echo "Build took ${SECONDS}s"

SECONDS=0
wait "$BOOT_PID" || tail -5 bootstatus.log
echo "Simulator ready ${SECONDS}s after the build"
exit $status
