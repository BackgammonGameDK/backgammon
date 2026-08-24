#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# manifest.json joined this set when the game became installable: it is
# served by Pages and referenced from index.html like any other asset, so a
# stale copy is the same class of problem. The icons deliberately stay out -
# they are immutable in practice, and a stale icon is cosmetic where a stale
# script is the mixed-old-and-new state this whole scheme exists to prevent.
VERSIONED_FILES="style.css firebase-config.js qrcode-generator.js rules.js sync.js script.js manifest.json"

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
  echo "Bump the version number on all seven tags in index.html before committing/deploying."
  exit 1
else
  echo "index.html's ?v= tags show changes. Verify all seven tags share the same new number."
  exit 0
fi
