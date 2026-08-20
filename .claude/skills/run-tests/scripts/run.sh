#!/usr/bin/env bash
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
TIMEOUT_SECS=15

if [ ! -x "$JSC" ]; then
  echo "jsc not found at $JSC — is this being run on macOS with Xcode/CLT installed?"
  exit 2
fi

OUT=$(mktemp)
"$JSC" run-tests.js > "$OUT" 2>&1 &
PID=$!

SECS=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 1
  SECS=$((SECS + 1))
  if [ "$SECS" -ge "$TIMEOUT_SECS" ]; then
    kill -9 "$PID" 2>/dev/null
    echo "TIMED OUT after ${TIMEOUT_SECS}s — this almost always means a stub in"
    echo "run-tests.js (document/sessionStorage/firebase/timers) no longer"
    echo "matches what rules.js or sync.js now expects. Check what changed in"
    echo "either file's exported shape before assuming a real hang in the tests"
    echo "themselves."
    rm -f "$OUT"
    exit 124
  fi
done

wait "$PID"
CODE=$?
cat "$OUT"
rm -f "$OUT"

exit "$CODE"
