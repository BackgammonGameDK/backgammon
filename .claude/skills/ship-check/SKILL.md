---
name: ship-check
description: Run all pre-push checks for this project in one pass — tests, cache-busting, and rules.js purity. Use before pushing, or when the user asks "is this ready to ship / push / deploy".
user-invocable: true
---

# Ship check

Runs three independent gates and reports one verdict, rather than
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

All three must pass for a clean exit (0). Fix whatever failed and rerun
rather than pushing past a failure — this is meant to run immediately
before `git push`, not as a general-purpose linter.
