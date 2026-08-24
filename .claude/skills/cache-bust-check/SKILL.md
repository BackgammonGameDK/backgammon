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

It compares which of the seven versioned files (`style.css`, `rules.js`,
`sync.js`, `script.js`, `firebase-config.js`, `qrcode-generator.js`,
`manifest.json`) have uncommitted changes against whether `index.html`'s
`?v=` tags were also touched. A non-zero exit means the version wasn't
bumped — fix `index.html` before committing.

`manifest.json` joined the set when the game became installable: it is
served by Pages and referenced from `index.html` like any other asset. The
icon PNGs are deliberately *not* in it — they are immutable in practice,
and a stale icon is cosmetic where a stale script is the mixed-old-and-new
state the scheme exists to prevent.

**All seven tags share one number and must be bumped together**, even if
only one file actually changed — the script only checks that *some* bump
happened, not that all seven stayed in sync, so visually confirm all seven
tags show the same new number after bumping.
