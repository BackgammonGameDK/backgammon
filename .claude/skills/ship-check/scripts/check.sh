#!/usr/bin/env bash
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

SKILLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0
WARN=0

echo "== 1/4: tests =="
if bash "$SKILLS_DIR/run-tests/scripts/run.sh"; then
  echo "PASS: tests"
else
  echo "FAIL: tests"
  FAIL=1
fi
echo ""

echo "== 2/4: cache-busting =="
if bash "$SKILLS_DIR/cache-bust-check/scripts/check.sh"; then
  echo "PASS: cache-busting"
else
  echo "FAIL: cache-busting"
  FAIL=1
fi
echo ""

echo "== 3/4: rules.js purity (no DOM access) =="
DOM_HITS=$(grep -nE '\b(document|window|querySelector|getElementById)\b' rules.js || true)
if [ -z "$DOM_HITS" ]; then
  echo "PASS: no DOM references in rules.js"
else
  echo "FAIL: rules.js references the DOM directly:"
  echo "$DOM_HITS" | sed 's/^/  /'
  FAIL=1
fi
echo ""

echo "== 4/4: docs freshness (CLAUDE.md / README.MD) =="
# Everything this push would carry: commits not yet upstream, plus anything
# still uncommitted. Falls back to diffing against main on a branch with no
# upstream set yet.
if BASE=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  :
else
  BASE=main
fi
CHANGED=$(
  {
    git diff --name-only "$BASE"...HEAD 2>/dev/null
    git status --porcelain | awk '{print $NF}'
  } | sort -u
)
# Files whose behaviour or conventions CLAUDE.md/README.MD actually describe.
DOCUMENTED=$(echo "$CHANGED" | grep -E '^(rules|script|sync)\.js$|^style\.css$|^index\.html$|^tests\.js$|^run-tests\.js$|^\.claude/skills/' || true)
DOCS_TOUCHED=$(echo "$CHANGED" | grep -E '^(CLAUDE\.md|README\.MD)$' || true)

if [ -z "$DOCUMENTED" ]; then
  echo "PASS: nothing documented by CLAUDE.md/README.MD changed"
elif [ -n "$DOCS_TOUCHED" ]; then
  echo "PASS: documented files changed, and the docs were updated alongside them"
else
  echo "WARN: these changed, but neither CLAUDE.md nor README.MD did:"
  echo "$DOCUMENTED" | sed 's/^/  /'
  echo ""
  echo "  Staleness is a judgement call, so this does not fail the run."
  echo "  Re-read the relevant doc sections and confirm they still describe"
  echo "  how the code actually works before pushing."
  WARN=1
fi
echo ""

if [ "$FAIL" -ne 0 ]; then
  echo "One or more checks failed. Fix before pushing."
  exit 1
elif [ "$WARN" -ne 0 ]; then
  echo "All gates passed, with a docs warning above. Clear to push once you've"
  echo "confirmed the docs are still accurate."
  exit 0
else
  echo "All checks passed. Clear to push."
  exit 0
fi
