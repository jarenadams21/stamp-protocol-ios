#!/bin/bash
# Runs one test selection on an already built project and classifies the result.
# Run from apps/ios after ios-build.sh, with UDID set.
#   ios-test.sh <name> unit
#   ios-test.sh <name> smoke | shard <N> | all [--include-quarantine]
# Writes results/<name>.log, .json (see ui-tests.mjs summarize), and .xcresult. A failing test is
# retried once; the script exits non-zero unless every test passed (possibly on retry).
set -uo pipefail
NAME=$1; shift
PLAN="$(cd "$(dirname "$0")" && pwd)/ui-tests.mjs"
mkdir -p results
ONLY=()
EXPECTED=()
if [ "$1" = unit ]; then
  ONLY=(-only-testing:JOEYYTests)
else
  node "$PLAN" list "$@" > "results/$NAME.expected" || exit 1
  while IFS= read -r arg; do ONLY+=("$arg"); done < <(node "$PLAN" args "$@")
  EXPECTED=(--expected "results/$NAME.expected")
  if [ ${#ONLY[@]} -eq 0 ]; then
    echo "No tests selected (all quarantined)."
    : > "results/$NAME.log"
  fi
fi

status=0
if [ ${#ONLY[@]} -gt 0 ]; then
  SECONDS=0
  # Timestamped, so slow phases (simulator preparation, app launch) show up in the log.
  xcodebuild test-without-building -project JOEYY.xcodeproj -scheme JOEYY \
    -destination "id=$UDID" -derivedDataPath DerivedData "${ONLY[@]}" \
    -retry-tests-on-failure -test-iterations 2 \
    -resultBundlePath "results/$NAME.xcresult" 2>&1 \
    | perl -MPOSIX -pe '$|=1; print strftime("[%H:%M:%S] ", gmtime)' > "results/$NAME.log"
  status=${PIPESTATUS[0]}
  grep -E "error:|Test Case .* failed|Executed|\*\* TEST" "results/$NAME.log" | tail -80
  echo "$NAME took ${SECONDS}s"
fi

node "$PLAN" summarize --suite "$NAME" --log "results/$NAME.log" --exit-status "$status" \
  ${EXPECTED[@]+"${EXPECTED[@]}"} --out "results/$NAME.json"
