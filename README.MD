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
6. **Bearing off** — endgame rules
7. **Polish** — win detection, restart button, possible simple AI opponent

Each stage is built and committed separately to keep changes small and reviewable.

## Status
🚧 In progress — currently on Stage 1.
