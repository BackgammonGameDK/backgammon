# Backgammon

An online, playable version of backgammon, built as a learning project to explore 
web development and working with an AI coding agent (Claude Code).

## Tech Stack
- HTML — structure and board layout
- CSS — styling and visual design
- JavaScript — game logic and interactivity

No frameworks, no build tools, no server — runs entirely in the browser, offline, 
by opening `index.html`.

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
   (a serializable state object, and rendering derived from it) is done —
   see Architecture below. A room/seat layer with a local-only transport
   (`sync.js`) is also done: two tabs on the same machine can share a game
   via a room code in the URL, with no backend at all. Remaining:
   - Swap that transport for Firebase Realtime Database, so two separate
     devices sync over the internet rather than two tabs on one machine.
   - Polish: disconnect handling, presence, a friendlier "share this link"
     flow.

   Decided up front: sync whole state snapshots rather than replaying moves
   (a dropped message can't silently desync the boards); rooms via a code in
   the URL, no accounts; friend-level trust, so each client validates its own
   moves and (once there's a real backend) database rules only restrict
   writing to your own turn.

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

`sync.js` is the multiplayer transport, written to a `joinRoom(...)` interface
that a Firebase-backed version can drop in behind without `script.js` needing
to change. For now it's backed by `localStorage` (a shared "room" record —
seats and the current game state) and `BroadcastChannel` (the live push
notification when it changes), which only works between tabs of the same
browser but mirrors the shape Firebase's Realtime Database will actually take:
a value you can read immediately on subscribing, plus live updates after that.
Every local state change goes through one `commitState()` call in `script.js`
rather than assigning `state` directly, so hot-seat and online play are the
same code path with one branch — and a game with no room code in the URL makes
zero `localStorage`/`BroadcastChannel` calls.

## Tests

Open `tests.html` in a browser. No framework, no build step, no dependencies —
the runner is about forty lines at the top of `tests.js`, extended to support
async tests since verifying `sync.js`'s cross-tab delivery genuinely requires
waiting for a message to arrive. The sync tests simulate two or three "tabs"
within one page — one `joinRoom` call per simulated tab, each getting its own
`BroadcastChannel`, exactly like a real second tab would.

The page loads its scripts with a cache-busting timestamp, because browsers
cache aggressively over `file://` and will otherwise re-run the previous
version of the code.

## Status
✅ Core build plan complete — stages 1-7 (including 5a and 5b) are all done: static board, checker movement, dice rolling, move legality, turn structure, dimmed used dice, bar re-entry, bearing off, win detection, and restart. The game is fully playable end to end.

Since then: Restart was separated from Roll to prevent mis-clicks, a "Hints" toggle was added to highlight a selected checker's legal destinations on request, a checker with no legal moves can no longer be selected at all, a pip count display (shown when Hints is enabled) was added, checkers now animate (slide) into place instead of jumping, the legal/invalid highlight colors were made colorblind-safe (blue solid ring vs. orange dashed ring, instead of red/green), black checkers got a lighter border so they're visible on the bar/off-tray, and the legal-target blue was softened to fit the board's wood-tone palette better.

The game state was then extracted out of the DOM into `rules.js` (see Architecture), with a test suite covering the rules — groundwork for multiplayer. Restart is now a state reset rather than a page reload.

A "Play Online" button now lets two tabs on the same machine share a live game via a room code in the URL (`sync.js`) — first to join is White, second is Black, further joins spectate. Moves, rolls, and restarts made in one tab appear in the other automatically. This works with no backend at all; the only thing left for real cross-device multiplayer is swapping the local transport for Firebase.

The game is also published online (GitHub Pages) and the layout is now responsive: the board keeps its 950x640 proportions but scales to fit the screen, with everything inside sized as a percentage of it. Desktop is unchanged at full size; phones get a compacted dice area, proportionally larger checkers, and a nudge to rotate to landscape, where a 24-point board has far more room.
