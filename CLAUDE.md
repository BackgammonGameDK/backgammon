# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A playable backgammon game built as a learning project (plain HTML/CSS/JS, no frameworks, no build tools, no server). Runs entirely offline by opening `index.html` in a browser. There are three files total: `index.html`, `style.css`, `script.js`.

## Running / previewing

There is no build, lint, or test tooling — this is intentional (see README.MD). To preview changes:

```bash
python3 -m http.server 8000
```

then open `http://127.0.0.1:8000/index.html`. A plain `file://` open can fail to load `style.css` in some sandboxed browser tooling, so prefer serving it locally when verifying changes. Don't commit the server process or any server-related files — it's a throwaway dev aid, not part of the app.

There are no automated tests. Verification has been done manually in-browser, often by driving `dispatchEvent`/DOM assertions through the browser console to set up specific board states (blots, bar checkers, near-bear-off positions) rather than clicking through a full game.

## Architecture

### Board numbering (the key mental model)

Points are numbered **1-24 absolute**, not per-player relative. White's home board is 1-6 and White moves toward *decreasing* numbers; Black's home board is 19-24 and Black moves toward *increasing* numbers. This single convention is threaded through everything:

- `isValidMove` derives legal direction from a checker's color and this numbering.
- `entryPoint(color, dieValue)` maps a die roll to a bar re-entry point: `25 - dieValue` for White, `dieValue` for Black — i.e. the bar acts as position "25" for White and position "0" for Black.
- `pipsFromOff(color, pointNumber)` maps a point to bear-off distance the same way: `pointNumber` for White, `25 - pointNumber` for Black.

A checker on the bar counts as 25 pips (`pipCount`) — the standard-rules maximum, consistent with the entry formula above.

### DOM is the state

There is no separate JS model of the board — the DOM *is* the game state. Checker position is "which `.point`/`.bar-checkers`/`.off-checkers` element is this `.checker` div a child of," queried live wherever needed (`checkersInPlay`, `getBarCheckers`, `colorOf`, `isOnBar`). Turn/dice state is similarly read off classes and attributes rather than mirrored in variables: `.die.played` / `.die.forfeited`, `data-point` on points, `data-owner` on the two off-trays. `currentPlayer`, `selectedChecker`, `gameOver`, and `hintsEnabled` are the only real JS state variables.

### Core rule engine

- `isValidMove(checker, fromPoint, toPoint)` — the single source of truth for direction + blocking (2+ opposing checkers) + hit detection. Reused everywhere: normal moves, bar entry, and the "can this die be used at all" check.
- `getLegalDestinations(checker)` — enumerates every point (or the off-tray) a specific checker could legally reach right now with the currently available dice. Backs both the Hints highlight feature and the rule that a checker with zero legal moves can't be selected — one function, two consumers.
- `canUseDie(value)` / `checkDiceAvailability()` — per-turn forced-play logic. A die only gets auto-forfeited (dimmed, "no legal move" message) once *no* checker can use it; bar checkers take priority (if any exist, only bar-entry legality is considered for that color, ignoring all other checkers). This re-evaluates on every roll and every move, so a die that looks unusable can un-dim later if the board state changes (see `checkDiceAvailability`'s comment-free but deliberate ordering — don't "optimize" this into a one-shot forfeit pass).
- `findBearOffDie` / `canBearOffWithValue` — bear-off die matching, including the official "overage" rule (a die larger than needed may bear off a checker only if it's the farthest-back one of that color remaining).

### Click handling

A single delegated `click` listener on `.board` dispatches in this order: bear-off tray → move to a point → select/deselect a checker → deselect (background click). Selecting a checker is gated by several independent conditions (right color, dice rolled, bar-priority, `getLegalDestinations().length > 0`) — when adding a new selection constraint, extend that condition list rather than adding a separate check elsewhere.

### Move animation

`animateMove(checker, moveFn)` wraps any `appendChild`-based re-parenting (a move is just moving a `.checker` div into a different container) with the FLIP technique: measure position before, perform the DOM move, measure after, apply an inverse `transform` with no transition, then clear it on the next frame with `.checker.animating`'s CSS transition so the browser animates the slide. This only touches `transform`, so it's safe to layer onto the flex-layout-driven structure without other changes. If a move gains a new re-parenting call site in the future, wrap it in `animateMove` too rather than a bare `appendChild`.

## Where things are documented

`README.MD` has the project's own build plan (stage-by-stage history), a running Future Improvements backlog, and a Status section — check it for what's already been decided or deliberately deferred (e.g. no doubling cube/multiplayer for now, no automated tests yet) before re-proposing those.
