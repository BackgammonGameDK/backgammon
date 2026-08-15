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
   (a serializable state object, and rendering derived from it) is now done —
   see Architecture below. Remaining:
   - Room/seat layer plus a `BroadcastChannel` transport, so two tabs sync
     with no backend at all — this lets the whole multiplayer design be built
     and debugged before any cloud account exists.
   - Swap that transport for Firebase Realtime Database, so two devices sync.
   - Polish: restart resets the shared game, disconnect handling, presence.

   Decided up front: sync whole state snapshots rather than replaying moves
   (a dropped message can't silently desync the boards); rooms via a code in
   the URL, no accounts; friend-level trust, so each client validates its own
   moves and database rules only restrict writing to your own turn.

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

## Tests

Open `tests.html` in a browser. No framework, no build step, no dependencies —
the runner is about twenty lines at the top of `tests.js`. The page loads its
scripts with a cache-busting timestamp, because browsers cache aggressively
over `file://` and will otherwise re-run the previous version of the code.

## Status
✅ Core build plan complete — stages 1-7 (including 5a and 5b) are all done: static board, checker movement, dice rolling, move legality, turn structure, dimmed used dice, bar re-entry, bearing off, win detection, and restart. The game is fully playable end to end.

Since then: Restart was separated from Roll to prevent mis-clicks, a "Hints" toggle was added to highlight a selected checker's legal destinations on request, a checker with no legal moves can no longer be selected at all, a pip count display (shown when Hints is enabled) was added, checkers now animate (slide) into place instead of jumping, the legal/invalid highlight colors were made colorblind-safe (blue solid ring vs. orange dashed ring, instead of red/green), black checkers got a lighter border so they're visible on the bar/off-tray, and the legal-target blue was softened to fit the board's wood-tone palette better.

The game state was then extracted out of the DOM into `rules.js` (see Architecture), with a test suite covering the rules — groundwork for multiplayer. Restart is now a state reset rather than a page reload.

The game is also published online (GitHub Pages) and the layout is now responsive: the board keeps its 950x640 proportions but scales to fit the screen, with everything inside sized as a percentage of it. Desktop is unchanged at full size; phones get a compacted dice area, proportionally larger checkers, and a nudge to rotate to landscape, where a 24-point board has far more room.
