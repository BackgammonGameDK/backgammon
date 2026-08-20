#!/usr/bin/env bash
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

SKILLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0

echo "== 1/3: tests =="
if bash "$SKILLS_DIR/run-tests/scripts/run.sh"; then
  echo "PASS: tests"
else
  echo "FAIL: tests"
  FAIL=1
fi
echo ""

echo "== 2/3: cache-busting =="
if bash "$SKILLS_DIR/cache-bust-check/scripts/check.sh"; then
  echo "PASS: cache-busting"
else
  echo "FAIL: cache-busting"
  FAIL=1
fi
echo ""

echo "== 3/3: rules.js purity (no DOM access) =="
DOM_HITS=$(grep -nE '\b(document|window|querySelector|getElementById)\b' rules.js || true)
if [ -z "$DOM_HITS" ]; then
  echo "PASS: no DOM references in rules.js"
else
  echo "FAIL: rules.js references the DOM directly:"
  echo "$DOM_HITS" | sed 's/^/  /'
  FAIL=1
fi
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "All checks passed. Clear to push."
  exit 0
else
  echo "One or more checks failed. Fix before pushing."
  exit 1
fi
