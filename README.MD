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
2. Selecting a piece with no valid moves is not possible.

## Status
✅ Core build plan complete — stages 1-7 (including 5a and 5b) are all done: static board, checker movement, dice rolling, move legality, turn structure, dimmed used dice, bar re-entry, bearing off, win detection, and restart. The game is fully playable end to end.

Since then: Restart was separated from Roll to prevent mis-clicks, and a "Hints" toggle was added to highlight a selected checker's legal destinations on request. Remaining work lives in Future Improvements above.
