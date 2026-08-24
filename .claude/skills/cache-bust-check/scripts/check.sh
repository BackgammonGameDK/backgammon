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

# Where the ?v= tags themselves live. manifest.json carries them too, for the
# icons it names - it is itself versioned from index.html, so a bump refetches
# the manifest and the manifest then points at fresh icons.
TAG_FILES="index.html manifest.json"

fail=0

# --- 1. do all the tags agree? --------------------------------------------
# Checked on every run, whether or not anything changed. This used to be a
# line of prose telling a human to confirm it by eye, which is exactly how
# style.css was once left a version behind while the script tags moved on -
# a mixed-old-and-new deploy that took a real debugging session to find. A
# machine should do the counting.
VERSIONS=$(grep -oh '?v=[0-9]\+' $TAG_FILES | sed 's/?v=//' | sort -u)
TAG_COUNT=$(grep -oh '?v=[0-9]\+' $TAG_FILES | wc -l | tr -d ' ')
DISTINCT=$(echo "$VERSIONS" | wc -l | tr -d ' ')

if [ "$DISTINCT" -ne 1 ]; then
  echo "FAIL: the ?v= tags disagree - found versions:" $VERSIONS
  echo "      Every tag in $TAG_FILES must carry the same number."
  grep -n '?v=[0-9]\+' $TAG_FILES | sed 's/^/        /'
  fail=1
else
  echo "All $TAG_COUNT ?v= tags agree on v=$VERSIONS."
fi

# --- 2. was a bump due, and did it happen? --------------------------------
CHANGED=$(git diff --name-only HEAD -- $VERSIONED_FILES)
CHANGED_STAGED=$(git diff --staged --name-only HEAD -- $VERSIONED_FILES)
ALL_CHANGED=$(printf '%s\n%s\n' "$CHANGED" "$CHANGED_STAGED" | sort -u | grep -v '^$' || true)

if [ -z "$ALL_CHANGED" ]; then
  echo "No versioned asset files have uncommitted changes, so no bump is due."
  exit $fail
fi

echo ""
echo "Changed versioned assets:"
echo "$ALL_CHANGED" | sed 's/^/  - /'
echo ""

VERSION_LINE_CHANGED=$(git diff HEAD -- $TAG_FILES | grep -E '^\+.*\?v=' || true)
VERSION_LINE_CHANGED_STAGED=$(git diff --staged HEAD -- $TAG_FILES | grep -E '^\+.*\?v=' || true)

if [ -z "$VERSION_LINE_CHANGED" ] && [ -z "$VERSION_LINE_CHANGED_STAGED" ]; then
  echo "WARNING: the ?v= tags do NOT appear to have changed."
  echo "Bump the version number on every tag before committing/deploying."
  exit 1
fi

echo "The ?v= tags show changes."
exit $fail
