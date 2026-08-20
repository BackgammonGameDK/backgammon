---
name: run-tests
description: Run this project's test suite (rules.js and sync.js) the reliable way. Use whenever the user asks to run tests, check tests pass, or verify a change didn't break anything.
user-invocable: true
---

# Run tests

Run the bundled script rather than typing the raw `jsc` command or opening
`tests.html` directly:

```bash
bash "$SKILL_DIR/scripts/run.sh"
```

It runs the suite under `jsc` (macOS's command-line JavaScriptCore) instead
of a browser tab — no build step, no flakiness, sub-second. It also wraps
the run with a timeout so a hang shows up as a clear timeout message
instead of the terminal just sitting there.

## Interpreting the result

- **`N/N passed`, exit 0** — genuinely clean, trust it.
- **A hang, or `NO RESULTS`** — this is not "tests are slow." It means a
  change to `rules.js`'s or `sync.js`'s shape broke one of the stubs
  `run-tests.js` uses to fake `document`/`sessionStorage`/`firebase`/timers
  (`jsc` has none of these natively). Look at what changed in either
  file's exported shape before assuming a real bug.
- **A failure that only reproduces via `tests.html` in a browser, not
  here** — before trusting it, check whether that browser tab was
  backgrounded (`document.hidden === true`). A backgrounded tab gets
  aggressive timer throttling that can push an async `sync.js` test's
  `waitFor` past its budget for reasons that have nothing to do with the
  code. Reproduce against a clean checkout (`git stash`) first, or just
  trust this script's result instead — it has no browser tab to throttle.
- **A failure here that's real** — this script's result is the
  non-flaky ground truth; a `tests.html` failure that doesn't reproduce
  here is the one to distrust, not the other way around.

Run this before any commit that touches `rules.js` or `sync.js`, and
before pushing.
