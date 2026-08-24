#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# manifest.json and the icons joined this set when the game became
# installable. The icons were left out at first, on the reasoning that they
# were immutable in practice and a stale one would only be cosmetic. Both
# halves of that turned out to be wrong within a day: the icon was replaced
# twice, and because its URL never changed, a player who deleted the
# home-screen app and re-added it still got the old picture from Safari's
# cache, with no way to force a refetch. Anything Pages serves and
# index.html or manifest.json points at belongs here.
VERSIONED_FILES="style.css firebase-config.js qrcode-generator.js rules.js sync.js script.js manifest.json icon-180.png icon-192.png icon-512.png icon-512-maskable.png"

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
  echo "Bump the version number on all eleven tags in index.html before committing/deploying."
  exit 1
else
  echo "index.html's ?v= tags show changes. Verify all eleven tags share the same new number."
  exit 0
fi
