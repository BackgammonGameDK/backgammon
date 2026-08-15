# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A playable backgammon game built as a learning project (plain HTML/CSS/JS, no frameworks, no build tools). Hot-seat play runs entirely offline by opening `index.html` in a browser; online play (two players, one game, synced live) additionally talks to a Firebase Realtime Database. Core files: `index.html`, `style.css`, `rules.js`, `script.js`, `sync.js`. `qrcode-generator.js` is a vendored, unmodified third-party QR encoder (MIT, kazuhikoarase/qrcode-generator) used only to render the online-play invite link as a scannable code — no network calls, runs entirely client-side. Tests live in `tests.html`/`tests.js`. `firebase-config.js`, `firebase.json`, `.firebaserc`, and `database.rules.json` are the Firebase project's configuration.

## Running / previewing

There is no build or lint tooling — this is intentional (see README.MD). To preview changes:

```bash
python3 -m http.server 8000
```

then open `http://127.0.0.1:8000/index.html`. A plain `file://` open can fail to load `style.css`, or serve a stale cached copy of a script you just edited, in some sandboxed browser tooling — prefer serving it locally when verifying changes, and see the Tests section below for how `tests.html` works around `file://` caching specifically. Don't commit the server process or any server-related files — it's a throwaway dev aid, not part of the app.

**`index.html`'s local `<script>`/`<link>` tags (`style.css`, `rules.js`, `sync.js`, `script.js`, `firebase-config.js`, `qrcode-generator.js`) carry a `?v=N` query string.** GitHub Pages caches static assets and there's no way to set custom cache headers there, so without this a returning visitor's browser can keep running an old cached file indefinitely after a deploy — silently mixing old and new files. This produced two real, confusing bugs, not just one: an old cached `sync.js` whose `claimSeat` still returned a color string instead of mutating the room object during Stage D (which is what prompted adding this in the first place) — and then `style.css` itself was overlooked when that fix was made, so a later CSS change (`--chrome` moving to `:root`) silently didn't take effect in a tab that had visited before, because only the `<script>` tags had been covered. **Bump `N` on all six tags whenever any of those files change, before deploying** — nothing else will remind you, and a forgotten bump is invisible until someone with a stale cache hits it.

Online play needs the Firebase SDK to actually reach the network — verifying it end-to-end means either two real tabs/devices pointed at the same room code, or working at the `rules.js`/`sync.js` level directly (see Tests).

## Architecture

### Board numbering (the key mental model)

Points are numbered **1-24 absolute**, not per-player relative. White's home board is 1-6 and White moves toward *decreasing* numbers; Black's home board is 19-24 and Black moves toward *increasing* numbers. This single convention is threaded through everything:

- `isValidMove` derives legal direction from a checker's color and this numbering.
- `entryPoint(color, dieValue)` maps a die roll to a bar re-entry point: `25 - dieValue` for White, `dieValue` for Black — i.e. the bar acts as position "25" for White and position "0" for Black.
- `pipsFromOff(color, pointNumber)` maps a point to bear-off distance the same way: `pointNumber` for White, `25 - pointNumber` for Black.

A checker on the bar counts as 25 pips (`pipCount`) — the standard-rules maximum, consistent with the entry formula above.

### State is a plain object; the DOM is rendered from it

`rules.js` holds the entire game state as a plain, JSON-serializable object (`{ points, bar, off, dice, currentPlayer, winner }`) and every rule as a pure function over it — no DOM access anywhere in that file. Checkers are interchangeable, so a point is just `{ color, count }`, not 15 individually tracked pieces. This split (state as data, rules as pure functions) is what makes the rules unit-testable without a browser, and what made syncing two players' boards possible at all — there'd be nothing to send over a network otherwise.

`script.js` owns the DOM half: it turns clicks into calls against `rules.js`, and renders the resulting state onto the board. **`state` is the single source of truth; the DOM is derived from it and never read back for game logic.** Every state change — a move, a roll, ending a turn, a restart — goes through one `commitState(newState)` call rather than assigning `state` directly, so hot-seat and online play are the same code path with one branch: apply locally and render, or hand it to `sync.js` to broadcast (which loops back to a local render via the same callback `sync.js` uses for remote updates — see below).

Rendering (`renderCheckers`) *reconciles* the existing checker elements against what the state says should be there, rather than rebuilding the board from scratch. Two reasons this matters: the FLIP move animation (`animateMove`) measures the same DOM element before and after a move, so a rebuild would silently kill the slide animation; and reconciliation means only the checkers that actually changed position get touched. It also has to actively remove any checker elements left over that the state no longer accounts for — during ordinary local play the count always balances out on its own (one checker moves from exactly one container to exactly one other), but rendering an externally-arrived state (a restart, or a board that just came from another player) can leave genuine surplus behind, and forgetting that step was a real bug caught during development.

### Core rule engine (`rules.js`)

Rule functions take the state object plus plain values, not DOM elements — e.g. `isValidMove(state, color, from, to)`, where `from`/`to` are point numbers or the `BAR`/`OFF` sentinels, not elements.

- `isValidMove(state, color, from, to)` — the single source of truth for direction + blocking (2+ opposing checkers) + hit detection. Reused everywhere: normal moves, bar entry, and the "can this die be used at all" check.
- `getLegalDestinations(state, color, from)` — enumerates every point (or `OFF`) a checker at `from` could legally reach right now with the currently available dice. Backs both the Hints highlight feature and the rule that a checker with zero legal moves can't be selected — one function, two consumers.
- `canUseDie(state, color, value)` / `hasAnyLegalMove(state, color)` — per-turn forced-play logic. A die only counts as unusable once *no* checker can use it; bar checkers take priority (if any exist, only bar-entry legality is considered for that color, ignoring all other checkers). Recomputed from scratch on every render (`renderDice`), so a die that looks dead can visually un-dim later if a prior move changed the board — don't try to cache or one-shot this into a forfeit flag stored on the die itself.
- `findBearOffDie` / `canBearOffWithValue` — bear-off die matching, including the official "overage" rule (a die larger than needed may bear off a checker only if it's the farthest-back one of that color remaining).
- `applyMove(state, color, from, to)` — returns `{ ok, state, hit }` and never mutates its input; a rejected move returns the original state unchanged. `script.js`'s `resolveTurn(next)` is a separate step layered on top — it decides whether the dice remaining after a move end the turn — and must run exactly **once**, on whichever client made the move, before the result is broadcast. Running it again on a state that already went through it (as a receiving client would see) would flip the turn a second time, since by then the dice are already empty.

### Click handling

A single delegated `click` listener on `.board` dispatches in this order: bear-off tray → move to a point → select/deselect a checker → deselect (background click). Selecting a checker is gated by several independent conditions (right color, dice rolled, bar-priority, `getLegalDestinations().length > 0`, and — in online play — `blockedOnline()`) — when adding a new selection constraint, extend that condition list rather than adding a separate check elsewhere.

### Move animation

`animateMove(checker, moveFn)` wraps any `appendChild`-based re-parenting (a move is just moving a `.checker` div into a different container) with the FLIP technique: measure position before, perform the DOM move, measure after, apply an inverse `transform` with no transition, then clear it on the next frame with `.checker.animating`'s CSS transition so the browser animates the slide. This only touches `transform`, so it's safe to layer onto the flex-layout-driven structure without other changes. It's called from inside `renderCheckers`'s reconciliation now, not from individual move handlers — any new re-parenting path should go through reconciliation rather than a bare `appendChild`.

### Multiplayer (`sync.js`)

Two players share one game via a room record at `/rooms/<code>` in Firebase Realtime Database: `{ seats: {white, black}, state, seq, presence }` — literally the same `rules.js` state object, whole snapshots synced rather than replaying individual moves (so a dropped message can't silently desync the two boards). `joinRoom(roomCode, { onRoom }, { clientId, database } = {})` is the interface `script.js` calls; `clientId` and `database` are seams for tests (see below), always omitted by real callers.

- **Seat assignment** is first-come-first-served, decided by a Firebase transaction (not a plain read-then-write) — two real devices can request a room at the literal same instant in a way two tabs on one machine never do, and a transaction is what guarantees they still land on different seats rather than racing onto the same one. A seat, once claimed, is never freed — a reload of the same tab reclaims it (see Identity below) rather than falling through to the other seat.
- **Presence** (`attachPresence`) is a separate `presence/<color>` entry under the same room record, written `true` while a seated client is connected and cleared automatically by Firebase's `.info/connected` + `onDisconnect()` idiom the moment that client's connection actually drops — a closed tab, a lost network, a crash, not something the client executes on its way out. It exists because seat occupancy alone can't distinguish "opponent hasn't joined yet" from "opponent was here and left" (a seat is never freed, per above); `script.js`'s room status line uses it for exactly that. `sendState` writes with `roomRef.update()` rather than `.set()` specifically so a move broadcast can't clobber the other seat's presence entry, which changes on its own timeline.
- **Identity** (`clientIdFor`) is stored in `sessionStorage`, deliberately not `localStorage`: `localStorage` is shared across every tab of one origin, which would make two tabs open to the same room collapse into a single client unable to hold two seats. `sessionStorage` is per-tab — a reload of the same tab reclaims its seat, a genuinely new tab gets a new one.
- **`onRoom(room, color)`** fires for every room change, whether this client caused it or another one did — Firebase's `on('value', ...)` echoes a client's own writes back to itself, so there's exactly one "the room changed, react to it" path, not a separate optimistic-update path for the sender.
- **`commitState`** in `script.js` is the only place `state` gets reassigned; it either applies locally (hot-seat) or calls `sync.js`'s `sendState` (online), which itself round-trips back through `onRoom` to actually update `state` and render — so a local move and a remote one are indistinguishable by the time they reach rendering.
- **A game with no room code in the URL never calls `sync.js`'s Firebase-touching code at all** — `defaultDatabase()` (which calls `firebase.database()`) is only reached if `database` isn't injected, and `joinRoom` is only called from the "Play Online" button or an existing `#room=` in the URL.
- **`database.rules.json`** restricts read/write to a specific `/rooms/<code>` path, and only if you already know the code — there's no listing, no accounts. This is friend-level trust: any seated client can write anything to its own room; nothing is validated server-side.

## Tests

`tests.html`/`tests.js` — no framework, no build step. Covers `rules.js` (pure functions, straightforward) and `sync.js` (against a small in-memory fake of the handful of Firebase calls it makes — `ref`/`transaction`/`on`/`off`/`set`/`update`/`remove`/`onDisconnect`, plus `.info/connected` — injected via `joinRoom`'s `database` option, so the suite has no live network dependency and isn't testing Firebase itself, only how this code uses it). The fake resolves everything asynchronously on purpose, which is what makes the concurrent-seat-claim test meaningful. Its store is a real nested tree, not a flat map keyed by path string — a write to a child path (e.g. presence, at `rooms/<code>/presence/<color>`) has to be visible to a `'value'` listener on the parent room path, same as real Firebase, and a flat map can't do that. A test-only `db._simulateDisconnect(path)` runs whatever `onDisconnect()` action was registered at that path, standing in for the server noticing a real connection drop (which nothing client-side can trigger for real).

`tests.html` loads its scripts with a cache-busting timestamp appended to the URL, because plain `<script src>` tags can serve a stale cached copy over `file://` in some sandboxed browser tooling even after the file on disk has changed — if you ever see a test result that doesn't match a change you just made, suspect this before suspecting the code, and try a hard reload or a `fetch()` + `eval()` of the file's current contents to rule it out.

Running `tests.html` inside a sandboxed/automated browser tab (as opposed to a normal foregrounded tab) can produce flaky failures in the async `sync.js` tests that have nothing to do with the code: a backgrounded tab (`document.hidden === true`) gets Chrome's aggressive background-timer throttling, which can push a test's `waitFor` past its budget purely from scheduling delay. Confirm before suspecting a real bug — reproduce the same failures against an unmodified checkout (e.g. `git stash`) first, and if you need a clean, fast, non-flaky run, execute the three files directly under a real JS engine outside the browser (macOS ships `jsc` at `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`; stub `document`/`sessionStorage`/`firebase`/`window` and eval `rules.js` + `sync.js` + `tests.js` in sequence).

## Where things are documented

`README.MD` has the project's own build plan (stage-by-stage history), a running Future Improvements backlog, and a Status section — check it for what's already been decided or deliberately deferred (e.g. no doubling cube, no AI opponent) before re-proposing those.
