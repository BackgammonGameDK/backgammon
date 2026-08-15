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
   Architecture below for how. Remaining:
   - Polish: disconnect handling, presence, a friendlier "share this link"
     flow.

   Decided up front: sync whole state snapshots rather than replaying moves
   (a dropped message can't silently desync the boards); rooms via a code in
   the URL, no accounts; friend-level trust, so each client validates its own
   moves and database rules only restrict writing to a room you already know
   the code for, not to whose turn it is.

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

## Status
✅ Core build plan complete — stages 1-7 (including 5a and 5b) are all done: static board, checker movement, dice rolling, move legality, turn structure, dimmed used dice, bar re-entry, bearing off, win detection, and restart. The game is fully playable end to end.

Since then: Restart was separated from Roll to prevent mis-clicks, a "Hints" toggle was added to highlight a selected checker's legal destinations on request, a checker with no legal moves can no longer be selected at all, a pip count display (shown when Hints is enabled) was added, checkers now animate (slide) into place instead of jumping, the legal/invalid highlight colors were made colorblind-safe (blue solid ring vs. orange dashed ring, instead of red/green), black checkers got a lighter border so they're visible on the bar/off-tray, and the legal-target blue was softened to fit the board's wood-tone palette better.

The game state was then extracted out of the DOM into `rules.js` (see Architecture), with a test suite covering the rules — groundwork for multiplayer. Restart is now a state reset rather than a page reload.

A "Play Online" button lets players share a live game via a room code in the URL (`sync.js`) — first to join is White, second is Black, further joins spectate. Moves, rolls, and restarts made by one player appear for the other automatically. First built and proven between two tabs on one machine with no backend at all, then backed by a real Firebase Realtime Database — the transport swap only touched `sync.js`, nothing else. Two separate devices, anywhere, can now play the same game.

The game is also published online (GitHub Pages) and the layout is now responsive: the board keeps its 950x640 proportions but scales to fit the screen, with everything inside sized as a percentage of it. Desktop is unchanged at full size; phones get a compacted dice area, proportionally larger checkers, and a nudge to rotate to landscape, where a 24-point board has far more room.

Two polish passes since: the board's height-aware sizing (previously phone-only) now also applies on desktop, so a browser window that isn't maximized shrinks the board to fit rather than running it off the bottom of the screen; and `#message`/`#game-over` no longer reserve empty space when there's nothing to show, closing what had become a visible gap between Roll and the board. A win now shows a dismissible full-screen celebration (confetti, a "Play Again" button) on top of the existing small status line, rather than only the status line.
