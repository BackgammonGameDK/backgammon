# Backgammon

An online, playable version of backgammon, built as a learning project to explore 
web development and working with an AI coding agent (Claude Code).

## Tech Stack
- HTML — structure and board layout
- CSS — styling and visual design
- JavaScript — game logic and interactivity

No frameworks, no build tools, no server of our own — runs entirely in the browser
by opening `index.html`. Hot-seat play is fully offline, zero network calls. Online
play (see Future Improvements) talks to a Firebase Realtime Database, so it needs
an internet connection, but nothing about hosting or building the game itself does.

## Build Plan
1. **Static board** — render the board and starting checker positions
2. **Checker movement** — click a checker, click a destination, move it (no rules yet)
3. **Dice rolling** — add a dice roller, display the roll
4. **Move legality** — enforce real backgammon rules (direction, blocked points, hitting blots)
5. **Turn structure** — alternate turns, use both dice values, handle doubles
5a. **Dim used dice** — Once dice are wired to moves (stage 4/5), visually dim a die once its value has been used for a move that turn. Purely visual — no change to game logic, just a state check on already-tracked used dice values.
5b. **Bar re-entry** — A checker sent to the bar (stage 4) must re-enter the opponent's home board (respecting blocked points) before its owner can make any other move. Was missed when the plan was first written; hitting currently leaves a checker permanently stuck on the bar.
6. **Bearing off** — endgame rules
7. **Polish** — win detection, restart button

Each stage is built and committed separately to keep changes small and reviewable.

## Future Improvements
Ideas beyond the core build plan, not scheduled to a specific stage:

1. AI opponent
2. Multiplayer synchronisation, planned in stages. The prerequisite refactor
   (a serializable state object, and rendering derived from it) is done, the
   room/seat layer is done, and it's now backed by a real Firebase Realtime
   Database — two separate devices, anywhere, can share a live game. See
   Architecture below for how. Presence and disconnect handling are done too
   (a seated player now sees "opponent disconnected" rather than silently
   waiting on a move that isn't coming — see Architecture). Joining a room
   now also has a friendlier flow beyond the original room code + copy-link
   button: a "Join" field takes the 6-character code typed directly (no
   link needed), and a QR code (rendered client-side, no external service)
   lets a second device join by scanning. Pasting the full link still works
   exactly as before.

   Decided up front: sync whole state snapshots rather than replaying moves
   (a dropped message can't silently desync the boards); rooms via a code in
   the URL, no accounts; friend-level trust, so each client validates its own
   moves and database rules only restrict writing to a room you already know
   the code for, not to whose turn it is.
3. UX/bug findings from a manual playtest (2026-08-15), highest-severity
   first. Three are fixed: mobile Restart no longer overlaps the turn
   indicator (`.status-row` now clears the fixed button's hit area on
   narrow/short screens, `style.css`), clicking a different own-color
   checker now switches the selection instead of being misread as a move
   attempt (`script.js`'s click handler), and the bear-off tray no longer
   scrolls — it renders only as many whole checkers as fit
   (`MAX_VISIBLE_OFF`, `script.js`) and shows the true count in a badge
   instead (`.off-count`, `style.css`). Points and the bar later got the
   identical treatment once testing found they had the same unbounded-pile
   problem the bear-off tray did (see Status). Still not fixed:
   - **Rejected clicks are silent.** Bar priority, no legal destinations,
     wrong color, dice not yet rolled — none of these show a message,
     unlike the existing "No legal move for N — skipped" text. `showMessage`
     already exists and is used for exactly three other cases.
   - **No hit announcement.** Sending an opponent's blot to the bar changes
     the board with no accompanying message — matters most online, where
     the other player has no other cue it happened.
   - **Turn indicator is stale after a win** — still reads "White's turn"
     next to "White wins!" once `state.winner` is set.
   - **The skip message and the reason for it disappear together.**
     `showMessage`'s 3s auto-clear (`script.js`) removes the only record of
     *why* a turn was skipped at the same time the now-empty dice do.
   - **The board is keyboard/screen-reader unreachable.** Only 6 controls
     (Restart, Hints, Play Online, room code, Join, Roll) are in the
     accessible tree; points and checkers are plain unlabeled `div`s with
     no role or `tabindex`, so a keyboard-only player can roll but not move.
   - **Latent:** `animateMove` (`script.js`) clears its FLIP transform via
     `requestAnimationFrame` plus a `transitionend` listener registered
     `{once: true}`; neither fires in a backgrounded/hidden tab, which is
     exactly the state a tab sits in while waiting on an opponent's move
     online. Queued rAF callbacks do run once the tab is shown again, so
     this is more a fragility than a confirmed bug, but it's worth clearing
     the transform defensively rather than depending on either callback.
   - **Minor:** `handleRoomUpdate` (`script.js`) clears `selectedFrom` on
     every room update; `commitState`'s hot-seat branch doesn't, leaving it
     to each caller. Every current caller does, so nothing is broken today,
     but it's an easy trap for a future one.
4. **Two standard backgammon "obligation" rules aren't enforced** — found by
   fuzzing `rules.js` directly (400 random games plus an exhaustive search
   over two-dice positions), not the manual playtest above. `isMoveLegal`
   validates a move in isolation; it never checks whether a *better*
   sequence was available this turn, so a player can knowingly waste a die.
   Two confirmed cases:
   - **Must use both dice if any order lets you.** White with dice `[6,1]`
     and checkers on 2 and 17 can play `17→16` (stranding the 6 - `10` is
     blocked and `2` can't bear off) instead of `17→11, 2→1` (uses both).
     The engine accepts the first.
   - **Must play the higher die if only one can be played at all.** Black
     with dice `[6,4]` and a lone mobile checker on 9 can play the 4
     (`9→13`) even though standard rules require the 6 (`9→15`) once only
     one of the two can be used this turn. The engine accepts the 4.

   Both need a one-turn lookahead over legal move sequences (small
   branching factor, cheap) rather than judging each move on its own -
   `applyMove` already returns a fresh state for exactly this kind of
   exploration, so the search doesn't need new plumbing. Skippable if not
   worth the complexity: this is friend-level trust software (see
   Multiplayer below) between two people already sharing a room code, and
   plenty of casual implementations don't enforce this either.

## Architecture

`rules.js` holds the game state and every rule, as pure functions over a plain
object — it never touches the DOM. `script.js` is the other half: it turns
clicks into moves and renders the resulting state onto the board. The state is
the single source of truth; the DOM is derived from it and never read back for
game logic. That split is what makes the rules testable without a browser, and
what a future multiplayer layer will sync.

Rendering reconciles the existing checker elements rather than rebuilding the
board, because the FLIP move animation measures the same element before and
after — a rebuild would silently kill it.

`sync.js` is the multiplayer transport, backed by Firebase Realtime Database.
The room record at `/rooms/<code>` (seats and the current game state) is exactly
what an earlier local-only rehearsal used, synced via `localStorage` and
`BroadcastChannel` between two tabs before any backend existed — that stage's
job was proving the design (rooms, seats, turn handoff) cheaply, and once it
worked, swapping in Firebase changed only `sync.js`'s internals. `script.js` was
already written against `joinRoom(...)`'s callback timing (it never fires
synchronously) because that's what `BroadcastChannel` naturally forced, and
that happens to be exactly what Firebase's `onValue` does too — a value you can
read immediately on subscribing, then live updates after — so no changes were
needed there. Seat-claiming uses a Firebase transaction rather than a plain
read-then-write, because two real devices can now request a room at the same
instant in a way two tabs you open yourself never do — a transaction is what
guarantees they still land on different seats rather than racing onto the same
one. Every local state change goes through one `commitState()` call in
`script.js` rather than assigning `state` directly, so hot-seat and online play
are the same code path with one branch — and a game with no room code in the
URL makes zero calls to Firebase.

Presence is layered on the same room record, at `/rooms/<code>/presence/<color>`:
a seated client writes `true` there while connected, using Firebase's
`.info/connected` + `onDisconnect()` idiom so the *server* clears it the
moment that client's connection actually drops — a closed tab, a lost
network, a crash — not something the client has to do itself on the way
out. This is what lets the other player's status line distinguish "hasn't
joined yet" (seat unclaimed) from "was here and left" (seat claimed,
presence gone), which seat occupancy alone can't do, since a seat is never
freed once claimed. `sendState` writes with `update()` rather than `set()`
for the same reason seats and presence live in the same record but are
written independently: a full-record `set()` would clobber whichever one
this client didn't just change.

`database.rules.json` restricts read/write to a specific `/rooms/<code>` path,
and only if you already know the code — there's no listing, no accounts,
matching the friend-level trust decided up front. `firebase-config.js` holds
the project's public client config (safe to commit — it identifies which
project to talk to, it isn't a secret; the rules are what actually gate access).

## Tests

Open `tests.html` in a browser. No framework, no build step, no dependencies —
the runner is about forty lines at the top of `tests.js`, extended to support
async tests since verifying propagation genuinely requires waiting for an
update to arrive. The sync tests run against a small in-memory fake of the
handful of Firebase calls `sync.js` actually makes (`ref`/`transaction`/`on`/
`off`/`set`), injected via `joinRoom`'s `database` option — real callers never
pass it, defaulting instead to an actual `firebase.database()`. This tests
*our* logic (seat assignment, initial-state seeding, propagation) without the
suite depending on a live Firebase project or a network call; testing whether
Firebase itself works isn't our job. The fake resolves everything
asynchronously on purpose, which is what makes the concurrent-join test
meaningful: it's checking the same guarantee a Firebase transaction gives two
genuinely simultaneous real devices.

The page loads its scripts with a cache-busting timestamp, because browsers
cache aggressively over `file://` and will otherwise re-run the previous
version of the code.

`run-tests.js` runs the same suite from the command line under `jsc`, with no
browser involved — worth preferring when a `tests.html` run gives a result that
looks wrong, since a backgrounded browser tab can fail async tests purely from
timer throttling. The `run-tests` skill (below) wraps it.

## Skills

Three skills under `.claude/skills/` automate the project's own routines, so
they're one command instead of something to remember at the moment you're least
likely to. Each is a short description file plus a shell script holding the real
logic, so any of them can also be run directly:

```bash
bash .claude/skills/ship-check/scripts/check.sh
```

- **`run-tests`** — runs the suite the reliable way (the `jsc` path above).
- **`cache-bust-check`** — catches the mistake of editing a versioned asset
  without bumping `index.html`'s `?v=N` tags. That mistake shipped a stale
  `sync.js` once and a stale `style.css` later, and both times it was invisible
  until someone with a warm browser cache hit it.
- **`ship-check`** — the pre-push gate: runs the two above, checks that no DOM
  reference has leaked into `rules.js` (see Architecture), and warns if code
  the docs describe changed without the docs changing too. That last one only
  warns, never blocks, because whether a doc has actually gone stale is a
  judgement call a script can't make for you.

These are conveniences layered on top of the project, not part of it — the game
itself still has no build step and no dependencies.

## Status
✅ Core build plan complete — stages 1-7 (including 5a and 5b) are all done: static board, checker movement, dice rolling, move legality, turn structure, dimmed used dice, bar re-entry, bearing off, win detection, and restart. The game is fully playable end to end.

Since then: Restart was separated from Roll to prevent mis-clicks, a "Hints" toggle was added to highlight a selected checker's legal destinations on request, a checker with no legal moves can no longer be selected at all, a pip count display (shown when Hints is enabled) was added, checkers now animate (slide) into place instead of jumping, the legal/invalid highlight colors were made colorblind-safe (blue solid ring vs. orange dashed ring, instead of red/green), black checkers got a lighter border so they're visible on the bar/off-tray, and the legal-target blue was softened to fit the board's wood-tone palette better.

The game state was then extracted out of the DOM into `rules.js` (see Architecture), with a test suite covering the rules — groundwork for multiplayer. Restart is now a state reset rather than a page reload.

A "Play Online" button lets players share a live game via a room code in the URL (`sync.js`) — first to join is White, second is Black, further joins spectate. Moves, rolls, and restarts made by one player appear for the other automatically. First built and proven between two tabs on one machine with no backend at all, then backed by a real Firebase Realtime Database — the transport swap only touched `sync.js`, nothing else. Two separate devices, anywhere, can now play the same game.

The game is also published online (GitHub Pages) and the layout is now responsive: the board keeps its 950x640 proportions but scales to fit the screen, with everything inside sized as a percentage of it. Desktop is unchanged at full size; phones get a compacted dice area, proportionally larger checkers, and a nudge to rotate to landscape, where a 24-point board has far more room.

Two polish passes since: the board's height-aware sizing (previously phone-only) now also applies on desktop, so a browser window that isn't maximized shrinks the board to fit rather than running it off the bottom of the screen; and `#message`/`#game-over` no longer reserve empty space when there's nothing to show, closing what had become a visible gap between Roll and the board. A win now shows a dismissible full-screen celebration (confetti, a "Play Again" button) on top of the existing small status line, rather than only the status line.

Online play now tracks presence (see Architecture): the room status line tells "waiting for opponent" (seat unclaimed) apart from "opponent disconnected" (seat claimed, but that player's connection just dropped) — previously indistinguishable, since a seat is never freed once claimed. Verified against the live Firebase project with two real tabs, including a genuine tab-close disconnect.

Joining a room got friendlier: a "Join" field next to "Play Online" takes a typed 6-character room code directly, and a "QR" toggle renders a scannable code for the current link (via a small vendored, dependency-free QR generator — no network call, no external service). Pasting the full invite link still works unchanged; these are additional ways in, not replacements.

A seated player can no longer roll or move before an opponent has actually joined — previously the room creator could start playing solo, since the only existing check was whose turn it was. And who goes first is no longer hardcoded to White: each side rolls one die (a tie rerolls automatically), the higher roll starts, and that player's first turn is pre-loaded with both individual rolls as its dice — the standard backgammon opening procedure, shown in the turn indicator ("opening roll: White 6, Black 3") and applying to hot-seat play too, not just online.

The board grows further on desktop now: it was already scaling to fit the window (see above), but on a typical wide-but-not-tall monitor the limit was available *height*, not width, leaving visible unused space on either side. The turn indicator, Hints checkbox, and pip count — three stacked rows — now collapse into one row on screens wider than 900px, freeing up the vertical room the board's sizing math immediately claims. Phones are untouched; they were already width-bound, not height-bound.

The room-status row ("Room XQ57M4 · You are White", Copy link, QR) used to stay put for the whole game, even though it's only actually useful before an opponent has joined. It now collapses to a small room-code chip the moment there's nothing left to report (opponent present and connected), reclaiming that space during play; clicking the chip reopens the same info and buttons as a popover, same as the QR code already floats rather than displacing the board.

Landscape phones got the same board-growing treatment as desktop, but the opposite layout move: rather than collapsing rows into one to free up height (desktop's problem), the dice/status/Roll chrome moves into a sidebar to the *left* of the board instead of sitting in a row above it — a landscape phone is height-limited, so a row above the board was spending the one dimension already in short supply. Freeing that lets the board's existing height-driven sizing grow it substantially; flexbox's normal shrink behavior keeps it from overflowing a landscape window too narrow for that, no extra sizing math needed the way `--chrome` needed for the height axis. Restart joined that sidebar too (moved to the end, with extra spacing) rather than staying fixed in its usual corner — a fixed corner the board doesn't know is spoken for was quietly capping how big it could grow, on top of briefly (and worse) overlapping it outright before that.

The desktop `<h1>` had never actually been styled — it was carrying the browser's default title margins (title case: fine on a generic page, wasteful on one whose whole layout budget is measured to the pixel), noticeably more headroom than the fixed Restart button right next to it uses. Trimmed to nearly match Restart, growing the desktop board a bit further.

Closed a fairness gap in the opening roll: it used to be generated the instant the room's creator opened it, before an opponent had joined, and Restart wasn't gated by opponent presence either — so the creator could sit alone in the room and hit Restart repeatedly, re-rolling the opening dice each time, and stop once one favored them, with nobody there yet to notice. The opening roll is now only generated once both seats are claimed, and Restart/Play Again are disabled (and no-op if triggered anyway) until then.

Testing turned up two real gaps this session: fuzzing `rules.js` (400 random games plus an exhaustive two-dice search, invariant-clean otherwise) found two unenforced dice-obligation rules, logged rather than fixed (see Future Improvements); and driving the actual UI found that points and the bar had the exact same unbounded-pile problem the bear-off tray was fixed for earlier, just never noticed because the standard starting position (5 per point, nothing on the bar) happens to be small enough to hide it. Six or more on a point, or several checkers sent to the bar at once, are both routine mid-game outcomes, not edge cases — past that, two adjacent stacks used to visually merge into one indistinguishable column. Points and the bar now get the identical treatment `MAX_VISIBLE_OFF` already gave the bear-off tray: render only as many whole checkers as fit, show the true count in a badge (`.point-count`, `.bar-count`) once it's needed. Points specifically needed a second, lower cap for once the badge itself is showing (`MAX_VISIBLE_PER_POINT_WITH_BADGE`) — getting that backwards during development capped the *standard opening position itself*, a bug worth flagging for the next round of work like this: measure the count-plus-badge case before assuming a single threshold covers both.

Also added `run-tests.js`, a `jsc`-based runner alongside `tests.html` for the flaky-browser-tab workaround CLAUDE.md's Tests section already described but never had a script for.

Most recently, three of the project's recurring manual routines became skills (see Skills above): running the tests the reliable way, checking the `?v=N` cache-busting bump, and a combined pre-push gate over both plus `rules.js`'s no-DOM rule. The pattern each one addresses is the same — the docs already explained the rule and *why* it mattered, having been written after the bug that taught it, but explaining a rule and enforcing it are different things, and the moment you most need the reminder is the one where you're least likely to go re-read a paragraph about it. The pre-push gate also warns when code the docs describe changes without the docs changing too; it deliberately only warns, since a script can spot the omission but can't judge whether the docs actually went stale. `.claude/` is tracked in git now so these travel with the repo, with the two machine-specific files inside it ignored instead.
