---
name: ship-check
description: Run all pre-push checks for this project in one pass — tests, cache-busting, rules.js purity, and docs freshness. Use before pushing, or when the user asks "is this ready to ship / push / deploy".
user-invocable: true
---

# Ship check

Runs four independent gates and reports one verdict, rather than
remembering to run each separately at the exact moment (right before a
push) you're least likely to:

```bash
bash "$SKILL_DIR/scripts/check.sh"
```

1. **Tests** — delegates to the `run-tests` skill's script. See that
   skill if this fails; don't reinterpret a timeout/hang here, its
   SKILL.md already explains what that actually means.
2. **Cache-busting** — delegates to the `cache-bust-check` skill's
   script. See that skill if this fails.
3. **`rules.js` purity** — greps `rules.js` for `document`, `window`,
   `querySelector`, `getElementById`. Any match is a real problem:
   CLAUDE.md's architecture section is explicit that `rules.js` holds
   game state and pure rule functions with no DOM access anywhere in the
   file — that split is what makes the rules unit-testable and made
   syncing two players' boards possible at all. A match here means a DOM
   reference leaked into the wrong file, not a style nitpick.
4. **Docs freshness** — if the push carries changes to files whose
   behaviour or conventions `CLAUDE.md`/`README.MD` describe (the core
   `.js`/`.css`/`.html` files, the test files, or anything under
   `.claude/skills/`) but neither doc changed too, it prints a warning
   naming them. Whether the docs are *actually* stale is a judgement
   call no script can make, so unlike gates 1-3 this one **warns without
   failing** — it exists to force the question at the one moment you'd
   otherwise skip it, not to answer it for you. Re-read the relevant
   sections and confirm they still match reality before pushing.

Gates 1-3 must pass for a clean exit (0); gate 4 can only warn. Fix
whatever failed and rerun rather than pushing past a failure — this is
meant to run immediately before `git push`, not as a general-purpose
linter.
