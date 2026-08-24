---
name: cache-bust-check
description: Verify index.html's ?v=N cache-busting tags were bumped before committing or deploying changes to style.css, rules.js, sync.js, script.js, firebase-config.js, or qrcode-generator.js. Use before any commit or deploy that touches those files.
user-invocable: true
---

# Cache-bust check

GitHub Pages caches static assets with no way to set custom cache headers,
so a returning visitor can keep running an old cached file indefinitely
after a deploy unless `index.html`'s `?v=N` query strings are bumped. This
has caused real, hard-to-diagnose bugs in this project before (see
`CLAUDE.md`'s "Running / previewing" section) — a stale `sync.js` and,
separately, a stale `style.css` each shipped unnoticed.

Run the bundled check before any commit that touches a versioned asset:

```bash
bash "$SKILL_DIR/scripts/check.sh"
```

It compares which of the eleven versioned files (`style.css`, `rules.js`,
`sync.js`, `script.js`, `firebase-config.js`, `qrcode-generator.js`,
`manifest.json`, and the four `icon-*.png`) have uncommitted changes
against whether `index.html`'s `?v=` tags were also touched. A non-zero
exit means the version wasn't bumped — fix `index.html` before committing.

The icons were left out of this set at first, on the reasoning that they
were immutable in practice and a stale one would only be cosmetic. Both
halves turned out to be wrong within a day: the icon was replaced twice,
and because its URL never changed, a player who deleted the home-screen
app and re-added it still got the old picture out of Safari's cache with
no way to force a refetch. The rule is now simply: anything Pages serves
that `index.html` or `manifest.json` points at is versioned.

Note the two-step chain for icons — `index.html` versions the
`apple-touch-icon` directly, while the manifest's icons are versioned
inside `manifest.json`, which is itself versioned from `index.html`. A
bump therefore refetches the manifest, which then points at fresh icons.

**All eleven tags share one number and must be bumped together**, even if
only one file actually changed — the script only checks that *some* bump
happened, not that all eleven stayed in sync, so visually confirm they all
show the same new number after bumping.
