#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VERSIONED_FILES="style.css firebase-config.js qrcode-generator.js rules.js sync.js script.js"

CHANGED=$(git diff --name-only HEAD -- $VERSIONED_FILES)
CHANGED_STAGED=$(git diff --staged --name-only HEAD -- $VERSIONED_FILES)
ALL_CHANGED=$(printf '%s\n%s\n' "$CHANGED" "$CHANGED_STAGED" | sort -u | grep -v '^$' || true)

if [ -z "$ALL_CHANGED" ]; then
  echo "No versioned asset files have uncommitted changes. Nothing to check."
  exit 0
fi

VERSION_LINE_CHANGED=$(git diff HEAD -- index.html | grep -E '^\+.*\?v=' || true)
VERSION_LINE_CHANGED_STAGED=$(git diff --staged HEAD -- index.html | grep -E '^\+.*\?v=' || true)

echo "Changed versioned assets:"
echo "$ALL_CHANGED" | sed 's/^/  - /'
echo ""

if [ -z "$VERSION_LINE_CHANGED" ] && [ -z "$VERSION_LINE_CHANGED_STAGED" ]; then
  echo "WARNING: index.html's ?v= tags do NOT appear to have changed."
  echo "Bump the version number on all six tags in index.html before committing/deploying."
  exit 1
else
  echo "index.html's ?v= tags show changes. Verify all six tags share the same new number."
  exit 0
fi
