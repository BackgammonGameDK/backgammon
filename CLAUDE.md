# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A playable backgammon game built as a learning project (plain HTML/CSS/JS, no frameworks, no build tools). Hot-seat play runs entirely offline by opening `index.html` in a browser; online play (two players, one game, synced live) additionally talks to a Firebase Realtime Database, either by sharing an invite link or through a matchmaking lobby that pairs two people who are both looking for a game. Core files: `index.html`, `style.css`, `rules.js`, `script.js`, `sync.js`. `qrcode-generator.js` is a vendored, unmodified third-party QR encoder (MIT, kazuhikoarase/qrcode-generator) used only to render the online-play invite link as a scannable code — no network calls, runs entirely client-side. Tests live in `tests.html`/`tests.js`. `firebase-config.js`, `firebase.json`, `.firebaserc`, and `database.rules.json` are the Firebase project's configuration.

## Running / previewing

There is no build or lint tooling — this is intentional (see README.MD). To preview changes:

```bash
python3 -m http.server 8000
```

then open `http://127.0.0.1:8000/index.html`. A plain `file://` open can fail to load `style.css`, or serve a stale cached copy of a script you just edited, in some sandboxed browser tooling — prefer serving it locally when verifying changes, and see the Tests section below for how `tests.html` works around `file://` caching specifically. Don't commit the server process or any server-related files — it's a throwaway dev aid, not part of the app.

**`index.html`'s local `<script>`/`<link>` tags (`style.css`, `rules.js`, `sync.js`, `script.js`, `firebase-config.js`, `qrcode-generator.js`, `manifest.json`) carry a `?v=N` query string.** GitHub Pages caches static assets and there's no way to set custom cache headers there, so without this a returning visitor's browser can keep running an old cached file indefinitely after a deploy — silently mixing old and new files. This produced two real, confusing bugs, not just one: an old cached `sync.js` whose `claimSeat` still returned a color string instead of mutating the room object during Stage D (which is what prompted adding this in the first place) — and then `style.css` itself was overlooked when that fix was made, so a later CSS change (`--chrome` moving to `:root`) silently didn't take effect in a tab that had visited before, because only the `<script>` tags had been covered. **Bump `N` on all seven tags whenever any of those files change, before deploying** — a forgotten bump is invisible until someone with a stale cache hits it. The `cache-bust-check` skill (see Skills below) catches a missed bump mechanically; run it before committing rather than relying on memory.

**The `?v=N` scheme has a blind spot: `index.html` itself.** Bumping the query string only helps once a browser fetches a fresh `index.html` to learn the new number, and GitHub Pages serves that file with `cache-control: max-age=600`. So for roughly ten minutes after a deploy, a returning visitor can keep using their cached `index.html`, which still asks for `?v=<old>` — and they still have *that* in cache too, with the old contents. The result is the exact mixed-old-and-new state this whole scheme exists to prevent, just moved up one level, and nothing can be done about it from inside the repo: custom headers aren't available on GitHub Pages. **So a fresh deploy has to be tested with a hard reload, not an ordinary revisit.** This produced a real bug report: after dice were given per-player colours, one device showed white dice on both players' turns while another showed them correctly — the first was running a cached `style.css` from before the change, which had no `.die.black` rule at all, so every die fell back to the default light styling. Suspect this before suspecting the code whenever a change appears to work on one device and not another.

Online play needs the Firebase SDK to actually reach the network — verifying it end-to-end means either two real tabs/devices pointed at the same room code, or working at the `rules.js`/`sync.js` level directly (see Tests).

## Architecture

### Board numbering (the key mental model)

Points are numbered **1-24 absolute**, not per-player relative — including when the board is drawn from Black's side (see Board perspective below); the numbering never flips, only the pixels do. White's home board is 1-6 and White moves toward *decreasing* numbers; Black's home board is 19-24 and Black moves toward *increasing* numbers. This single convention is threaded through everything:

- `isValidMove` derives legal direction from a checker's color and this numbering.
- `entryPoint(color, dieValue)` maps a die roll to a bar re-entry point: `25 - dieValue` for White, `dieValue` for Black — i.e. the bar acts as position "25" for White and position "0" for Black.
- `pipsFromOff(color, pointNumber)` maps a point to bear-off distance the same way: `pointNumber` for White, `25 - pointNumber` for Black.

A checker on the bar counts as 25 pips (`pipCount`) — the standard-rules maximum, consistent with the entry formula above.

### State is a plain object; the DOM is rendered from it

`rules.js` holds the entire game state as a plain, JSON-serializable object (`{ points, bar, off, dice, currentPlayer, winner, phase, openingRoll }`) and every rule as a pure function over it — no DOM access anywhere in that file. Checkers are interchangeable, so a point is just `{ color, count }`, not 15 individually tracked pieces. This split (state as data, rules as pure functions) is what makes the rules unit-testable without a browser, and what made syncing two players' boards possible at all — there'd be nothing to send over a network otherwise.

`script.js` owns the DOM half: it turns clicks into calls against `rules.js`, and renders the resulting state onto the board. **`state` is the single source of truth; the DOM is derived from it and never read back for game logic.** Every state change — a move, a roll, ending a turn, a restart — goes through one `commitState(newState)` call rather than assigning `state` directly, so hot-seat and online play are the same code path with one branch: apply locally and render, or hand it to `sync.js` to broadcast (which loops back to a local render via the same callback `sync.js` uses for remote updates — see below).

Rendering (`renderCheckers`) *reconciles* the existing checker elements against what the state says should be there, rather than rebuilding the board from scratch. Two reasons this matters: the FLIP move animation (`animateMove`) measures the same DOM element before and after a move, so a rebuild would silently kill the slide animation; and reconciliation means only the checkers that actually changed position get touched. It also has to actively remove any checker elements left over that the state no longer accounts for — during ordinary local play the count always balances out on its own (one checker moves from exactly one container to exactly one other), but rendering an externally-arrived state (a restart, or a board that just came from another player) can leave genuine surplus behind, and forgetting that step was a real bug caught during development.

### Core rule engine (`rules.js`)

Rule functions take the state object plus plain values, not DOM elements — e.g. `isValidMove(state, color, from, to)`, where `from`/`to` are point numbers or the `BAR`/`OFF` sentinels, not elements.

- `isValidMove(state, color, from, to)` — the single source of truth for direction + blocking (2+ opposing checkers) + hit detection. Reused everywhere: normal moves, bar entry, and the "can this die be used at all" check.
- `getLegalDestinations(state, color, from)` — enumerates every point (or `OFF`) a checker at `from` could legally reach right now with the currently available dice. Backs the Hints highlight feature, the rule that a checker with zero legal moves can't be selected, and (in the click handler) disambiguating a click on a different own-color checker from a legal stacking move onto it — one function, three consumers.
- `canUseDie(state, color, value)` / `hasAnyLegalMove(state, color)` — per-turn forced-play logic. A die only counts as unusable once *no* checker can use it; bar checkers take priority (if any exist, only bar-entry legality is considered for that color, ignoring all other checkers). Recomputed from scratch on every render (`renderDice`), so a die that looks dead can visually un-dim later if a prior move changed the board — don't try to cache or one-shot this into a forfeit flag stored on the die itself.
- `findBearOffDie` / `canBearOffWithValue` — bear-off die matching, including the official "overage" rule (a die larger than needed may bear off a checker only if it's the farthest-back one of that color remaining).
- `applyMove(state, color, from, to)` — returns `{ ok, state, hit }` and never mutates its input; a rejected move returns the original state unchanged. `script.js`'s `resolveTurn(next)` is a separate step layered on top — it decides whether the dice remaining after a move end the turn — and must run exactly **once**, on whichever client made the move, before the result is broadcast. Running it again on a state that already went through it (as a receiving client would see) would flip the turn a second time, since by then the dice are already empty.
- **The opening phase.** A game has two phases, held in `state.phase`: `opening`, the standard procedure for deciding who starts, and `playing`, everything after. The phase is stored rather than derived from `openingRoll`'s contents — the rule ("both present and equal means a tie, present and different means we already left") is exactly the kind of implicit invariant that goes wrong quietly later.
  - `createInitialState()` is **deterministic** and rolls nothing: `dice: []`, `openingRoll: { white: null, black: null }`, `phase: 'opening'`. `currentPlayer` is a placeholder that means nothing until the phase resolves — both players may roll, in either order.
  - `rollOpeningDie(state, color, randomFn)` throws one player's die. It is a no-op (returning the same object, which `script.js` checks for) if the phase is over or that player has already rolled this round, so a double tap or a duplicate broadcast can't overwrite a die already showing.
  - A **tie is left on screen** rather than cleared, so both players actually see the round they lost; whoever rolls next clears it and starts a fresh one. `isOpeningTie(state)` recognises it, and is well-defined because `resolveOpening` leaves the phase as `opening` with both dice present *only* in that case.
  - `resolveOpening` starts the game once both dice differ: the higher one is `currentPlayer`, and the two individual values become that turn's dice — same as any other turn, no special doubles handling, since a tie is the only way they could match and a tie doesn't resolve. `openingRoll` then stays as the display banner (`script.js` folds it into the turn indicator, e.g. "White's turn — opening roll: White 5, Black 2") until `endTurn` clears it to `null`.

  This is also why `createInitialState` no longer takes `randomFn` — there is nothing left in it to randomise. The seam moved to `rollOpeningDie`.

### Start screen (`#start-screen`)

The app opens on an explicit choice — **Find an opponent** (the only filled button, since matchmaking is the ordinary route in), Play on this device, Rejoin your last room when there is one, and a room-code field folded behind a quiet toggle — rather than dropping straight into a hot-seat game with online play as one more button beside Roll and Hints. Built as a full-viewport overlay, the same shape `#celebration` uses, so it sits on top of the finished layout instead of displacing it and therefore needs no space in `--chrome`. The board renders behind it from `idleState()`: the standard opening position with `dice` and `openingRoll` cleared, purely a backdrop.

**Nothing rolls until a mode is chosen.** `state` used to be initialized with `createInitialState()` at module load, which meant the opening roll happened before the player had chosen anything — the "why are there already dice?" confusion the screen exists to remove. `idleState()` is a backdrop only; picking a mode is what creates the real state (hot-seat calls `createInitialState()` at the moment of the click; online leaves seeding to `handleRoomUpdate`, unchanged). Generating a state at load and merely revealing it later would move that confusion behind one click rather than fix it.

`gameStarted` is a separate flag from `state` having content, because the backdrop *is* a valid state — nothing about the object says "no game yet". Every path that acts on the board checks it (`renderDice`'s Roll `disabled`, the Roll click handler, the board click handler) rather than trusting the overlay to cover the controls. `leaveStartScreen()` is the only thing that sets it, and both entry paths go through it.

**Rejoin (`renderStartScreen`)** offers the last room this browser joined, from `lastRoomCode()` in `sync.js` — the thing that makes Exit safe, since leaving an online game would otherwise mean needing the invite link again to get back. It's recomputed every time the screen is shown rather than once at load, so the code Exit just left behind is the one offered and a mis-tapped Exit is one tap from being undone. First among the online options, because a returning player is exactly who needs it; a first-time visitor never sees it. `rememberRoom()` is called from `startOnline()`, so every way into a room — create, join by code, invite link, rejoin — records it through one place.

`lastRoomCode()`/`rememberRoom()` wrap their storage access in try/catch, unlike `identityFor`, and the difference is deliberate: `identityFor` only runs when someone actually joins a room, while `lastRoomCode` runs on **every page load** to decide whether the Rejoin button appears. Safari's private mode has historically thrown on storage access, so an unguarded read there would take down the whole app for a visitor who only ever wanted a hot-seat game and never touched storage before this feature existed. Losing the Rejoin button is an acceptable failure; losing the game is not.

**Exit (`exitToStartScreen`) is the way back**, and is the only path that unwinds a game rather than replacing one. It tears down whichever kind of game was running and restores the screen to what a fresh visit would find — a new `idleState()`, `gameStarted` back to false, the room code off the URL via `replaceState` (assigning `location.hash` would leave a bare `#` and push a history entry for a screen the player is already looking at), and Restart/Play Again re-enabled, since `renderRoomStatus` disables them while online and nothing else would turn them back on. Online, it also announces the departure — see Multiplayer below.

**A URL carrying `#room=CODE` skips the screen entirely** — `startOnline()` calls `leaveStartScreen()` itself, so an invite link or QR scan opens straight into the game rather than stopping to ask a question it has already answered. This is the path most worth re-checking after any change here.

**One filled button, and it is "Find an opponent".** Since the lobby landed, that is the ordinary way to play, so it leads and is the only filled control; hot-seat and Rejoin stay full-width buttons but outlined, which ranks them without burying them. The earlier version gave hot-seat and online equal weight, which was right when "online" meant generating a code and texting it to somebody, and stopped being right once the lobby made matchmaking the default. The room-code field is folded behind a quiet "Have a room code?" toggle — codes are a fallback for someone who was sent one, not a route the average player should read past.

**Validation errors go to `#start-error`, not `showMessage`.** `#message` lives in the dice area, *behind* this overlay — a rejected room code would set text nobody can see, leaving the screen looking unresponsive. Found exactly that way while building the screen. The join controls exist only on the start screen, so `joinWithCode` always routes there.

`.online-area` holds only `#room-status`, and **that row earns its space only while it has something to say**. During an ordinary game it does not: the room code is in the address bar if anyone wants it, and Copy link matters while you are waiting for somebody rather than while you are playing them. So the row goes away and the board grows into it — worth about **+56px of board width at desktop** — and comes back by itself the moment there is news: an opponent who has not arrived, who disconnected, or who left. That last case is also exactly when you would want Copy link and QR back, which is why they return with it. A spectator always sees the row, since otherwise nothing on screen would say they cannot play.

`--reclaimed` therefore keys on `body.showing-room-row` (set by `renderRoomStatus`) rather than on whether this is an online game at all, so hot-seat and a live online game get the same board. This replaced an earlier collapse-to-a-chip-with-a-popover treatment, which spent a row on a code the URL already carries.

### Click handling

A single delegated `click` listener on `.board` dispatches in this order: bear-off tray → switch selection to a different own-color checker → move to a point → select/deselect a checker → deselect (background click). Selecting a checker is gated by several independent conditions (right color, dice rolled, bar-priority, `getLegalDestinations().length > 0`, and — in online play — `blockedOnline()`) — when adding a new selection constraint, extend that condition list rather than adding a separate check elsewhere.

The switch-selection branch exists because a click on a different own-color checker is inherently ambiguous with a move attempt onto its point — both `.point` and `.checker` match the same click. It only fires when the clicked point *isn't* actually a legal destination for the currently selected checker (via `getLegalDestinations`, see above); when it is (e.g. stacking your own checker onto another), the click falls through to the move-to-a-point branch unchanged, so a legal stack still executes instead of reselecting.

`blockedOnline()` also covers the Roll button's click handler (and its `disabled` state in `renderDice`) — the same gate serves both because rolling and moving are both "acting on the state." Beyond spectator/off-turn checks, it blocks a seated player until the opponent's seat has been claimed at all (`room.seats[other]`), not merely until they're currently connected (`room.presence`) — seats are never freed once claimed (see Multiplayer below), so this only ever blocks the window before a game's second player has shown up for the first time, never a later disconnect of an opponent who already played.

**`blockedOnline()` does not apply during the opening phase.** Nobody is on turn while it's being decided — both players roll, in either order — so the turn comparison can't mean anything yet, and the phase check returns early. It sits *after* the spectator and opponent-seat checks, so a player alone in a room still can't roll. What stops you rolling twice is `rollDisabled()`, not this.

`bothSeatsClaimed(room)` is a second, separate gate: `handleRoomUpdate` only seeds a brand-new room's starting state (`createInitialState()`, White does the seeding) once both seats are claimed, and `restartGame()` — which isn't turn-gated by `blockedOnline()`, since either player can restart regardless of whose turn it is — no-ops under the same condition (and the Restart/Play Again buttons are visually disabled to match, in `renderRoomStatus`). Its original reason was anti-abuse: `createInitialState` used to roll the opening itself, so the room's creator, alone, could hit Restart repeatedly and stop once a roll favoured them, invisible to an opponent who wasn't there yet. **That reason is gone** now the roll belongs to the players and a fresh game contains none. The gate stays for the plainer one: there is no game to seed or reset until somebody is there to play it.

### Move animation

`animateMove(checker, moveFn)` wraps any `appendChild`-based re-parenting (a move is just moving a `.checker` div into a different container) with the FLIP technique: measure position before, perform the DOM move, measure after, apply an inverse `transform` with no transition, then clear it on the next frame with `.checker.animating`'s CSS transition so the browser animates the slide. This only touches `transform`, so it's safe to layer onto the flex-layout-driven structure without other changes. It's called from inside `renderCheckers`'s reconciliation now, not from individual move handlers — any new re-parenting path should go through reconciliation rather than a bare `appendChild`.

### Restart asks twice (`restartNeedsConfirming`, `armRestart`)

Restart wipes a game in progress for **both** players, either of them can press it at any time, and unlike Exit it isn't recoverable — the start screen can offer a room back, but not a board. On a phone it sat one mis-tap from destroying a live game, and putting Exit beside it made that likelier.

So a mid-game Restart **arms on the first press and acts on the second**, showing "Restart?" in amber with a hint in `#message`. Two deliberate taps in the same place is a real guard against the actual threat — a slipped thumb — and costs nothing when the press was meant. A native `confirm()` would be blunter and a modal more code; neither buys anything against a mis-tap.

`restartNeedsConfirming()` is `state.phase === 'playing' && !state.winner`. A finished game or one still deciding who starts restarts on the **first** press, because "are you sure you want to play again?" is a question nobody needs asked. **Play Again on the win overlay never confirms** — a new game is the entire point of that button.

Two things disarm it besides the second press: a 4-second timeout, and **any state change at all** (`disarmRestart()` runs at the top of `render()`). The second matters more than it looks: the confirmation was armed over a particular board, and if that board has moved on — the opponent played, or restarted themselves — the second tap would be answering a question nobody is asking any more. It fails toward *not* restarting.

Still unsolved, and worth knowing: **the other player gets no say.** One player's confirmed Restart still ends the other's game without warning. A restart *request* the opponent accepts is a bigger feature; this only stops the accident.

### Taking a move back (`turnHistory`, `undoLastMove`)

Mis-taps are easy on a phone-sized board, so the last move of the current turn can be taken back, restoring both the board and the die it consumed.

`turnHistory` is a stack in `script.js` and **deliberately not part of `state`**: an undo stack is a UI affordance, not game data, and putting it in the state object would broadcast one player's deliberations to the other and drag it through serialization for nothing.

**Each entry keeps the state from before its move *and* a JSON snapshot of the state immediately after it.** The second is the safety catch: `canUndo()` only offers an undo while the live board still equals that snapshot. A history left stale by anything else — the opponent hitting Restart mid-turn being the dangerous one — therefore can't be committed and resurrect a dead board. If the comparison ever fails for a benign reason it fails *safe*, disabling Undo rather than doing the wrong thing. `pruneUndoHistory()` (called from `render()`, so every state-changing path passes through it) additionally drops a history belonging to a turn that is no longer current, whoever ended it.

Three deliberate limits:

- **Never during the opening phase.** Undoing a die you rolled to decide who starts is just re-rolling, which is cheating — the one case where undo would change fairness rather than convenience.
- **Never once the turn has ended** (`recordUndoPoint` clears the stack instead of pushing). Online the opponent may already be acting on it, and even in hot-seat that would mean un-ending a turn rather than un-making a move. Picking the dice up ends the turn in the real game too.
- **Online, an undo broadcasts** and the opponent watches the checker go back. That is what taking a move back looks like across a real board, and it is the honest behaviour given every move is already broadcast as it is made. Holding moves locally until the turn ended would mean rewriting the `commitState`/`resolveTurn` contract everything else rests on.

The button shares one flex row with Roll rather than taking a row of its own — a new row in `.dice-area` would change `--chrome` and silently shrink the board. Its padding is `9px` against Roll's `10px` because its 1px border makes up the difference: **the row must be exactly as tall as Roll alone**, or the real chrome quietly exceeds the hand-measured budget. Verified by measurement (board bottom lands on the same pixel as before), not by eye.

### The tab title as a turn cue (`renderDocumentTitle`)

Playing online on a phone otherwise gives no sign that the opponent has moved — you switch to another app, and the only way back to the game is to go and look. The tab's title is the one channel a page still has once it isn't the thing on screen, so it reads `● Your turn — Backgammon` (or `● Your roll` during the opening) whenever the game is waiting on this client, and plain `Backgammon` otherwise.

`titleCue()` is deliberately not "is it my turn": during the opening phase both players may act at once and what's owed is a die, not a move. It returns null for hot-seat, spectators, a finished game, and a room whose opponent hasn't arrived yet — in that last case the room status line already explains the wait.

**Written on every render, with no `visibilitychange` listener and no check on `document.hidden`.** A title is a status indicator, not a notification, so it should simply say what's true; that removes the whole "was the tab hidden when this arrived?" class of edge case, and it clears when the turn passes rather than when the player happens to look. The marker leads because a tab strip truncates from the right.

Two deliberate omissions, both worth knowing before "improving" this:

- **`navigator.vibrate` cannot work here.** The spec has vibration ignored outright while the document is hidden, which is precisely the case worth signalling.
- **The Notifications API would genuinely reach a backgrounded phone**, but it needs a permission prompt and, on iOS, the site installed to the home screen as a PWA before notifications arrive at all — a manual step nobody finds unprompted. Sending one also needs something server-side, which for this project means Firebase's paid plan even though the free quota would cover the volume. **Deliberately skipped** — see README's Future Improvements for the full reasoning before proposing it again.

Its real limit: a mobile browser that discards a backgrounded tab stops running the page at all, so no title update happens either. This helps while you're briefly in another app, not when you return the next day — that case is what seat recovery in `sync.js` is for.

### Saying why (`selectionProblem`, `wasHit`, sticky messages)

A click that does nothing is the most confusing thing the board can do to someone still learning, and four separate rules can produce one. `selectionProblem(state, color, from)` in `rules.js` says which — `not-your-turn`, `no-dice`, `bar-first`, `no-moves`, or null — and `script.js` turns the code into a sentence. **It lives in `rules.js` because it is a rule, not presentation**: what stops you picking up a checker is exactly what the engine already knows about it, and being pure it is testable without a browser. `canSelect` is now just this function returning null.

**The order is deliberate**, most fundamental first: there is no use being told a checker is stuck when the real problem is that you have not rolled. A refusal is only explained when the click actually landed on a checker or point — answering taps on the bare board would turn the message line into noise.

**A hit is announced to both sides, by different routes.** The player doing it reads `applyMove`'s `hit`. The player it happens to is told by `wasHit(previous, next, color)`, computed in `handleRoomUpdate` *before* `state` is replaced, because nothing in the broadcast says a hit occurred — online the board simply changes underneath them, which is no cue at all.

**`showMessage(text, { sticky })`** skips the three-second auto-clear. The skipped-turn notice uses it: the dice that explain *why* a turn was skipped are cleared by the skip itself, so a timed message removed the only surviving record of the reason at the same moment as the evidence. Sticky messages are cleared by the player's next action (`clearMessage` in `attemptMove` and the Roll handler), not by a clock.

**`#message` floats rather than stacking**, and this is load-bearing rather than decorative. In `.dice-area`'s flex column it added a row the moment a click was refused, which moved the board mid-game — measured at +24.5px for one line and +43px for two on a portrait phone. Worse on a height-bound desktop window: `--chrome` is hand-measured and never allowed for that row, so at 1280x800 the board's bottom edge went from 768px to 794.5px and a two-line message would have run it off the screen. It is now `position: absolute` against `.dice-area`, hanging from `top: 100%` onto the board's top edge, with a background so it stays legible there and `pointer-events: none` so it can never swallow a click on a point beneath it (verified: a click through the toast lands on the point).

Three things about that rule are considered choices, not defaults. **It needs `width: max-content`** — shrink-to-fit against the space left of `left: 50%` is half the row, and a one-line message wrapped into four. **It hangs downward rather than straddling the edge**: centring it on the boundary covers Roll when the message runs to two lines, and a button you cannot press for three seconds costs more than a partly-hidden top row does. **Landscape phones put it back in the flow** (`position: static`), because there `.dice-area` is a sidebar and a message row costs the board nothing — measured, the board's rect is identical either way — while floating from a sidebar would drop the toast at the bottom of the screen, nowhere near the click it explains.

`#game-over` is deliberately left in the flow, so it still moves the board once at the end of a game. It is persistent rather than transient, and a chip parked over the board's top edge for as long as the result is showing would be worse than the shift.

**The turn indicator says "Game over" once won**, rather than continuing to claim a turn next to "White wins!". It says something rather than emptying because `.status-row`'s height is part of the board's hand-measured budget.

Two hygiene fixes live here too. `commitState` clears `selectedFrom` for both branches, since `handleRoomUpdate` already did and the hot-seat path did not — harmless while every caller cleared it themselves, an easy trap for the next one that does not. And `animateMove` clears its FLIP transform on a timeout as well as `transitionend`: neither that event nor `requestAnimationFrame` fires in a hidden tab, which is exactly where a tab sits while waiting on an opponent's move.

### Checking a state that arrived from somewhere else (`isStructurallyValid`, `isLegalSuccessor`, `judgeArrivingState`)

`sendState` broadcasts whole snapshots and any seated client may write one, which was a fair simplification while a room could only be reached by someone sent its code. **The lobby seats you with strangers**, so an arriving state is now checked before it is believed.

All three live in `rules.js` and are pure, so the whole thing is unit-testable without a browser.

- `isStructurallyValid(state)` — properties every state this engine produces satisfies, judged one state at a time: fifteen checkers a side, points that are `null` rather than zero-count, dice of 1-6 in counts of 0/1/2/4 (four only from doubles, so all equal), a known phase and player, and **a winner who has actually borne off fifteen**.
- `isLegalSuccessor(previous, next, seen)` — could `next` have come from `previous`? A restart is always allowed (either player may, and `createInitialState` is deterministic so it is one exact value to compare against). Otherwise the checks are monotonic: the idle player cannot have gained ground (their `off` cannot rise, their pips cannot fall — being hit raises them, which is legal), and the player on turn cannot go backwards or bear off more than four.

**`seen` is how undo is handled** — by memory, not by reasoning backwards. An undo reverts to a state broadcast moments ago, so `script.js` keeps the last eight accepted states and an incoming match is accepted. That covers Firebase echoing a client's own writes too.

- `judgeArrivingState(previous, next, { accepted, rejected })` — the decision the other two only inform, returning `{ verdict, reason, rejected }` where the verdict is `accept`, `resync` or `refuse` and `rejected` is the updated refusal list, so the caller works nothing out for itself. `script.js` turns `reason` into a sentence (`refusalNotice`), the same split `selectionProblem`/`selectionMessage` already uses.

**Why the decision is a named function rather than a few lines in `script.js`.** That is where it used to live, in `handleRoomUpdate`, which nothing can test — and both of the bugs this protection has produced were in exactly those lines rather than in the checks they call. Extracted and pure, it is covered by eleven tests, including the two cases that shipped broken.

**The first state a room hands over is exempt, and has to be.** `isLegalSuccessor` judges a *step*, so there must be a state to have stepped from — and on joining there is not. What is on screen is `idleState()`, the pre-game backdrop, which this room never produced. A game in progress is not a legal step from it: the opponent has been moving all along, so by the backdrop's reckoning they have gained ground on a turn that is not theirs, which is precisely the fabricated-win shape the check exists to catch. So an empty `accepted` list is what says "nothing has come from this room yet", and `judgeArrivingState` passes `null` as the baseline in that case — `isLegalSuccessor`'s existing `if (!previous) return true` seam. Structural validity is the whole bar for that first state, which is the right bar: there is nothing to contradict, and a board that was already there when you arrived is not something any amount of checking could verify.

This was a real, live wedge, not a hypothetical. Two players rejoined a game in progress; both refused the true board, and neither could resynchronise past it, because that takes three *distinct* refusals and a room where both players are stuck sends nothing further. Only one of them needs to be live for it to self-heal, which is why it took both rejoining to surface. `startOnline()` therefore clears `acceptedStates`/`rejectedStates` itself, so "nothing has arrived from this room yet" is a fact about entering a room rather than a promise every caller has to have kept.

**`handleRoomUpdate` renders exactly once, unconditionally**, and that is structural rather than tidy. It applies the seat and room-status changes, calls `adoptRoomState(room)` — which does everything a decision cannot: seeds an empty room, swaps in the state, keeps the memory, and *returns* whatever the player should be told — then renders and shows that notice. There is one exit, so no path can forget.

The earlier version returned early on every refusal and on a room with no state yet, and each of those paths left the screen showing the render from *before* the client went online: the backdrop's "White, roll to see who starts" over a game that had moved on, and a Roll button still disabled from when `gameStarted` was false. The underlying bug was one refused state; what made it read as a dead app rather than a sync hiccup was the stale screen. Returning a notice instead of calling `showMessage` mid-flow is what makes the single exit possible.

One deliberate behaviour change came out of that: **a resync now wins over the hit notice** when both apply. Across a resync the two states being compared are several moves apart, so "you were hit" is a guess about which turn it happened on, while "the board jumped" is true and worth saying.

**Two states are compared with `canonicalJson`, never `JSON.stringify`.** `JSON.stringify` follows insertion order and **Firebase returns a record's keys sorted**, so a state that has been through the database never matches the identical state built locally: `createInitialState` writes `{ white: 0, black: 0 }` and the same object reads back `{ black: 0, white: 0 }`. Same board, different string. That is a second thing the database does to a record besides stripping nulls, and it is easier to miss because nothing about the values changes.

It cost a finished online game its Play Again button. `isFreshStart` compared stringified states, so the restart was not recognised as one, and `isLegalSuccessor` then refused it for sending every checker back to the start — which no move can do. Both players sat looking at a game that would not clear, with "Ignored an impossible move from your opponent." underneath. `canonicalJson` lives in `rules.js`, and `isFreshStart`, the `seen` lookup, `acceptedStates`, `rejectedStates` and the undo snapshots all go through it — the ones that were correct were correct only because both sides of the comparison happened to have come from the same place.

**The test fake reorders keys the way Firebase does** (`firebaseKeyOrder` in `tests.js`), which is what would have caught this. It sits alongside the fake's null-stripping and ServerValue resolution for the same reason: a fake that only models what you would naively expect lets the real difference ship. `assertEqual` compares canonically for the same reason — key order is never what an equality assertion in this suite means.

**`handleRoomUpdate` applies two bars, not one**, and the distinction is the important part:

- **A structurally impossible board is refused outright, always.** No amount of missed traffic can produce sixteen checkers, so accepting one later would be accepting a fabrication.
- **So is an unexplained win.** Being talked into a loss you could not verify is the worst outcome available here, so a win must arrive as a legal step or not at all.
- **Everything else is refused only for a while.** A client that has fallen behind — a reconnect delivers only the latest state — legitimately sees jumps it cannot account for, and refusing forever would wedge the game permanently. That is a worse and far likelier harm than an unpunished cheat, so after three *distinct* refused states it accepts and resynchronises. Distinct rather than a plain count on purpose: a client that is behind watches the game move on, so what it refuses keeps changing, whereas the same board arriving again is far likelier to be someone leaning on it. Resending one rejected board therefore gets nowhere.

**The governing bias throughout: reject only what is definitely impossible.** A false rejection breaks a legitimate game, which is worse than the cheating it prevents — hence monotonicity rather than replaying the exact move sequence, which would be far more code and far likelier to refuse something legal. Two things are deliberately not attempted: detecting dice fraud (a client rolling well is indistinguishable from luck without a shared seed) and enforcing that a move used a die legally, which is item 4's territory and should not wait on this.

### The lobby (`sync.js`'s lobby section, `findOrStartRoom`)

Two people who both pressed "play online" used to land in two different empty rooms and wait for each other forever — the codes are random, so they never met. The lobby closes that.

**It advertises rooms wanting a second player, not players wanting games.** That falls out of creating the room when someone starts *searching* rather than when they are matched. A searcher creates a room, takes White and advertises it; a later searcher claims that advertisement and joins as Black. **The advertiser needs no matchmaking logic at all** — it is already listening to its own room, so the game begins the moment the second seat fills, whether that came from the queue or from a link the player texted someone. One waiting state, two ways out of it.

`findOrStartRoom` is the whole decision in one call, and lives in `sync.js` rather than `script.js` so the round trip that matters — two searchers reaching the same room — is provable without a browser.

**The transaction trap, which cost a live debugging session.** Claiming deletes an entry through a transaction, and the update function must **never abort by returning `undefined` when `current` is null**. Firebase runs that function optimistically against its local cache — usually empty — *before* it has the server's value, so a null first invocation means "not fetched yet", not "already taken". Aborting there kills the transaction before it reaches the server and claiming silently never works. Deleting unconditionally is correct: if the server disagrees Firebase re-runs with the real value, and the closure variable is set on that pass. **This cannot reproduce against a fake that hands over the true value on the first call**, which is why `createFakeDatabase` now simulates the optimistic null pass and honours an abort during it.

Entries are matched **oldest first**, so the longest wait is served rather than whoever sorts earliest by id; a client never claims its own advertisement (that would seat it in its own room as both players); and `advertiseRoom` writes its entry only after the `onDisconnect` registration lands, with a `stopped` flag so a withdrawal in that window is not overtaken by its own advertisement.

**An entry can still be stale** — the room it points at may have filled from an invite link in the meantime. The claimer then lands as a spectator, which is not a choice the player made, so `handleRoomUpdate` recognises that (`joinedFromLobby`) and backs out to the start screen with "That game had just filled up — try again" rather than stranding them watching strangers.

**Security.** `/lobby/waiting` is readable and writable by anyone: there are no accounts, and a queue nobody can read is not a queue. That is a real step out from this project's "you must already know the code" posture, and it is why `database.rules.json` validates the *shape* of an entry — a six-character room code, a server-set `createdAt`, and nothing else — even though it cannot yet validate who wrote it. The blast radius is deliberately this one node; rooms keep their own rules, so a lobby full of junk cannot touch a game in progress. **Rules are not served by GitHub Pages** — they are deployed separately with `firebase deploy --only database`, and until that runs every lobby call fails with permission denied.

### Board perspective (`setBoardPerspective`)

Backgammon is played across a board: the player sitting opposite sees their own home board bottom-right and moves toward it. White gets that view by default from the fixed markup, so **an online client seated as Black gets `.black-perspective` on `.board`**, which swaps the two rows. That alone produces the whole mirror — Black's home (19-24) lands bottom-right, their bear-off tray beside it, their bar in the row they re-enter into, and point 1, where their back checkers start, top-right. Horizontal order inside each quadrant is already correct and must not change.

**Presentation only.** `rules.js` numbers points 1-24 absolutely and neither knows nor cares who is looking, so both players' `state` stays byte-identical while their screens differ — verified directly, by hashing `state` on two clients in one room and confirming the hashes match while one board is flipped. That is also what keeps a move meaning the same point on both sides: Black playing 1→4 puts a checker on absolute point 4, and White sees it there.

**Done with flex ordering (`column-reverse`), never a transform.** A `scaleY(-1)` or `rotate(180deg)` would give the same picture, but it inverts the coordinate space `animateMove`'s FLIP measurement works in, so every checker would slide the wrong way vertically — and it would mirror the count badges' text too. Reordering costs nothing and leaves both alone. If you ever reach for a transform here, that is the reason not to.

Two consequences worth knowing:

- With the rows swapped, each point sits on the opposite edge, so `.point-down` takes on `.point-up`'s styling and vice versa — triangle direction, flex direction, and which padding it uses. The overflow badge follows for free, since `renderOverflowBadges` appends it last and last-in-flex-order is the narrow tip either way.
- **`barContainers` keys on the bar's `data-owner`, not on which row it sits in.** It used to select `.board-row.top .bar-checkers`; once the rows can swap, a selector phrased in terms of position means the wrong bar.

Hot-seat and spectators keep White's view — with two people at one screen there is no "your side" to take, and a spectator has no seat. `setBoardPerspective` is idempotent by construction (`classList.toggle` with an explicit boolean), which matters because `handleRoomUpdate` calls it on every room change rather than only the first, and `exitToStartScreen` resets it **outside** its online branch: that function restores the screen to what a fresh visit would find, and that shouldn't depend on how the board came to be flipped.

### Installed to the home screen (`manifest.json`, the head of `index.html`)

The game is installable: Share → Add to Home Screen gives it an icon that opens
full screen, with no address bar and its own entry in the app switcher. That is
worth having for a reason beyond looks — the board is the tightest thing on a
phone screen, and browser furniture costs it height. `manifest.json` plus eight
lines in the head is the whole feature; there is no service worker and no
install prompt.

**There is deliberately no `viewport-fit=cover`, and that is the load-bearing
decision.** Without it iOS keeps the page inside the safe area, so `100dvh` is
the *usable* height and every hand-measured `--chrome` constant stays valid
exactly as measured. Going edge-to-edge would mean `100dvh` starting to include
the status bar and home-indicator strips — sizing the board for roughly 90px it
cannot use — and would require re-deriving all four `--chrome` values plus their
paired `--online-row`s, whose failure mode is silent. It would also drop
`.corner-controls` (`top: 8px; right: 8px` on small screens) under the Dynamic
Island, and drag `.status-row`'s measured `margin-top: 36px` along with it. The
cost of staying inside the safe area is two thin strips, which `theme-color`
paints `#2b2b2b` to match the page. **Stage 1 changed no CSS at all**, and the
board's rect was measured identical before and after at 375×812, 1280×800 and
812×375 — if a change here moves any of those, something is wrong.

`apple-mobile-web-app-status-bar-style` is `black` rather than
`black-translucent` for the same reason: the translucent variant is precisely
what forces content under the status bar.

**`start_url` is `./index.html` with no hash, on purpose.** iOS otherwise pins
the icon to whatever URL was showing when it was added, so an icon added
mid-game would relaunch into that room every time — and rooms now delete
themselves once spent, so it would relaunch into one that no longer exists.
Paths are relative (`./`) because the site is served from `/backgammon/` on
Pages, not a domain root.

**The icon is the game's own board, generated rather than drawn**
(`tools/make-icons.py`): the right half at the opening position, with every
colour lifted from `style.css` and every checker from `initialPoints()` in
`rules.js`. The right half is the one worth showing — it holds both home boards,
and the opening position puts a five-stack and a two-stack in each row.

The script is run by hand and committed alongside its output; it is not build
tooling and nothing invokes it, so the "no build step" property is intact. It
exists because the icon encodes constants that live in two other files, and a
palette change would otherwise leave four opaque PNGs nobody could regenerate.
It uses only `zlib` and `struct`, there being no Pillow on this machine and no
SVG rasteriser. One deliberate infidelity: the checkers are drawn slimmer than
the real board's 78% of point width, because points 19 and 6 share a column and
their five-stacks all but touch at full size — which at 180px reads as a single
stripe of beads rather than two opposing stacks.

**The icons are not in the `?v=N` set**, so replacing one does not invalidate
anything else — but iOS copies the icon when the game is added to the home
screen, so an already-installed player keeps the old one until they remove and
re-add it.

Two consequences that are documented rather than fixed. **An installed app is a
separate storage context from Safari**, so its `localStorage` starts empty: the
first launch offers no Rejoin, and a seat held in a Safari tab is not
recoverable from the icon (`identityFor` mints a fresh id). One-time, not
ongoing. And **`renderDocumentTitle`'s "● Your turn" cue is invisible in
standalone** — there is no tab strip to show it. Nothing breaks; the cue is
simply gone, which is worth knowing since it was the only signal a backgrounded
game had.

**Without a service worker the app still needs network to launch** — the icon
loads the page from Pages, so offline it shows Safari's error page rather than
the game. Caching the shell would fix that and is free, but it layers a second
cache-invalidation problem on top of the `?v=N` scheme documented above, which
has already caused two real bugs; done carelessly it turns the ten-minute stale
window into "until the user deletes the app". Left out on purpose (see README's
Future Improvements).

### Responsive layout (`style.css`, `script.js`)

`--chrome` (a root CSS var, redefined per breakpoint) is every pixel of vertical space besides the board's own height, subtracted in `.board`'s `max-width: calc((100dvh - var(--chrome) + var(--reclaimed)) * 950 / 640)` so the board fills whatever's left. It's measured by hand against the actual rendered layout, not calculated from the CSS rules or guessed (see the comment on the base value for the method), and has to be re-measured whenever the content above/around the board changes height — nothing else catches a stale value except the board quietly running off the bottom of the viewport, or leaving unused space it could have grown into.

`--chrome` is measured against the *tallest* state the layout takes, which is an online game: `.online-area` then holds `#room-status`, uncollapsed, with its longest status text. Measuring against the tallest is what guarantees the board can never overrun. A hot-seat game has no room status, so `body:not(.online) .online-area` is hidden outright — removing its flex gap too, not merely its content — and `--online-row` is how much height that frees, measured per breakpoint the same by-hand way, as the difference in `.board`'s top offset between the two states. `--reclaimed` is what the calc actually spends: `0px` by default, and `var(--online-row)` only on a `body` without the `.online` class that `startOnline()` adds. So an online game keeps exactly the budget it always had, and only hot-seat spends the difference (+57px of board width at the ≥901px breakpoint). The check that the value is right is that the board's *bottom edge* lands in the same place in both modes — too large a value shows up as the board overrunning it.

**Two cascade collisions to know about, both found on screen rather than by reading the stylesheet.** `#play-online-button` had an ID rule left over from when the online controls lived in the dice area, and an ID silently outranks `.start-primary`, so the button rendered small and outlined while the stylesheet appeared to say otherwise — it is now excluded from that group. And `#start-content #join-area` sets `display`, which outranks `#join-area[hidden]`, making the hidden attribute decorative; the hidden rule is now specific enough to win. That is the same trap `#room-status` and friends already carry a note about, in its other form: not author-beats-user-agent, but ID-beats-class.

**Landscape phones set `--online-row: 0px` explicitly, and must.** There `.dice-area` is a sidebar beside the board, so its height was never part of the vertical budget and there is nothing to reclaim; inheriting the base value would inflate the budget by space the board never had and run it off the bottom of the screen.

Landscape phones (`max-height: 500px and (orientation: landscape)`) are the one breakpoint where chrome sits *beside* the board — `.dice-area` as a fixed-width sidebar — rather than above it: a landscape phone is height-limited, so a row above the board spends the one dimension already scarce. This needs no separate width-based budget constant the way `--chrome` covers height: `.board` keeps the default `flex-shrink: 1` while `.dice-area` is `flex-shrink: 0`, so flexbox automatically caps the board's width to whatever's left of the sidebar with no extra `calc()`. The one thing that doesn't come for free is `#restart-button`, which is `position: fixed` in every other breakpoint — a fixed element takes no part in flex sizing, so it has to actually join the sidebar's flex flow here (moved to the end of `.dice-area` in `index.html`) rather than staying fixed; leaving it fixed either means separately reserving space for it (tried first, and it shrank the board more than joining the sidebar does) or letting the board silently grow underneath it.

The bear-off tray (`.off`), the bar (`.bar`), and points all cap how many checkers they actually render (`MAX_VISIBLE_OFF`/`MAX_VISIBLE_BAR`/`MAX_VISIBLE_PER_POINT`, `desiredLayout` in `script.js`), independent of the true count in `state` — past the cap, a checker is simply never appended to the DOM rather than appended and visually clipped, so it "disappears" instead of overflowing its container. Anything that belongs to a player takes that player's colours, rather than picking its own: `.off-count[data-owner="black"]` matches `.checker.black`'s fill and border, and `.die.white`/`.die.black` do the same, so a die reads as belonging to whoever rolled it. The one place that convention is deliberately broken is a black die's border — a checker sits on the wood board, but dice sit on the `#2b2b2b` page where `#222` is nearly invisible, so the border has to carry the contrast and is lighter than the checker's `#666`. Same reason the `.die.played` dim (35% opacity) is softened for black dice: at that opacity a dark die on a dark page reads as absent rather than spent.

`.off-count`/`.bar-count`/`.point-count` are the only places the real count is shown, and read `state` directly rather than counting DOM children, since the DOM count is deliberately capped and would undercount past the cap. The off tray and bar always show their badge once the count is above zero (same as each other, small trays that empty at the start of every game); a point's badge is conditional instead — created only once its count actually exceeds `MAX_VISIBLE_PER_POINT`, removed once it doesn't — because with 24 points, most holding a handful of checkers that fit fine in routine play, an always-on badge would be clutter rather than the rare exception the other two are. That conditional badge is also why points need *two* thresholds where the tray/bar need one: `MAX_VISIBLE_PER_POINT` (how many fit with no badge at all - notably 5, matching the standard opening position's own max stack) and the smaller `MAX_VISIBLE_PER_POINT_WITH_BADGE` (how many fit once the badge is actually showing, since the badge itself takes up room). Collapsing these into a single constant was a real bug during development: it silently cropped the standard starting position itself, showing a "4 + badge" pile on every point that opens at 5, because 5 alone was being judged against the with-badge threshold. Re-measure any of these the same way `--chrome` is re-measured (by hand, against the rendered layout) if checker/tray/point/badge sizing changes.

`#room-status` is hidden outright once there's nothing left to actively report, rather than collapsing to a chip as it once did — `renderRoomStatus` derives that from the same `status` string it already builds for the "waiting"/"disconnected" text, not a separate condition, so the two can't drift out of sync. See "the room row earns its space" above for why the board takes the freed height. `#qr-panel` still floats below its trigger rather than displacing anything, so opening it doesn't add to `--chrome`.

**The rotate hint (`#rotate-hint`) dismisses on a tap and stays dismissed.** It is advice, not news: worth saying once to someone meeting a 24-point board on a portrait phone, and clutter for the rest of the game to someone who read it and decided to stay in portrait. So it is a `<button>` whose whole row is the target (the `×` marks it as pressable rather than being the only thing you can hit), and the dismissal is remembered in `localStorage` — `localStorage` rather than `sessionStorage` because the preference is about the phone rather than the tab, and a mobile browser discarding a backgrounded tab would otherwise bring the hint back mid-game. That read runs on every page load, so it is wrapped in try/catch for the same reason `lastRoomCode` is (see Multiplayer): Safari's private mode has historically thrown on storage access, and losing the memory of a dismissal is an acceptable failure where losing the app is not.

Two things it does *not* need. It costs no `--chrome` re-measurement: it only shows at `max-width: 600px and (orientation: portrait)`, where the board is width-bound (`width: 100%` hits the viewport long before the height calc does), so hiding it moves the board up 30px without resizing it — verified by measuring `.board` before and after a dismissal. And it needs no render pass, since nothing in the game state can change it. **`#rotate-hint[hidden]` has to be its own rule**, though: the media query sets `display: flex` on the bare ID, and an author rule outranks the user-agent `[hidden] { display: none }` regardless of order — the same cascade trap `#room-status` and `#join-area` already carry notes about. ID + attribute is what wins.

### Multiplayer (`sync.js`)

Two players share one game via a room record at `/rooms/<code>` in Firebase Realtime Database: `{ seats: {white, black}, state, seq, presence, departed, lastActive }` — `state` is literally the same `rules.js` state object, whole snapshots synced rather than replaying individual moves (so a dropped message can't silently desync the two boards). `joinRoom(roomCode, { onRoom }, { clientId, recoveredClientId, database } = {})` is the interface `script.js` calls; all three options are seams for tests (see below), always omitted by real callers.

- **Seat assignment** is first-come-first-served, decided by a Firebase transaction (not a plain read-then-write) — two real devices can request a room at the literal same instant in a way two tabs on one machine never do, and a transaction is what guarantees they still land on different seats rather than racing onto the same one. A seat, once claimed, is never freed — a reload of the same tab reclaims it (see Identity below) rather than falling through to the other seat.
- **Presence** (`attachPresence`) is a separate `presence/<color>` entry under the same room record, written `true` while a seated client is connected and cleared automatically by Firebase's `.info/connected` + `onDisconnect()` idiom the moment that client's connection actually drops — a closed tab, a lost network, a crash, not something the client executes on its way out. It exists because seat occupancy alone can't distinguish "opponent hasn't joined yet" from "opponent was here and left" (a seat is never freed, per above); `script.js`'s room status line uses it for exactly that. `sendState` writes with `roomRef.update()` rather than `.set()` specifically so a move broadcast can't clobber the other seat's presence entry, which changes on its own timeline.
- **`lastActive`** is written on every `sendState`, riding along on the same `update()` so it can't land separately from the move that caused it. It exists to tell stale rooms apart: nothing deletes rooms, because `database.rules.json` grants access only to a room whose code you already know, there's no listing, and no client has business removing someone else's room — so cleanup is a Firebase-console job until there's a scheduled one. Two details are load-bearing. It uses Firebase's **server-timestamp sentinel, never `Date.now()`**: a device with a wrong clock would otherwise make a dead room look fresh or bury a live one. And **nothing writes it on join**, so a room whose second player never arrived has no `lastActive` at all — a more useful signal than a timestamp, since it says the room was never played rather than played and gone quiet.

  The sentinel is defined as a local constant (`SERVER_TIMESTAMP`) rather than read from `firebase.database.ServerValue.TIMESTAMP`, which is exactly the same value. That keeps `defaultDatabase()` the *only* place in `sync.js` touching the `firebase` global, which is what lets both test runners exercise this file without the SDK loaded — `tests.html` loads only `rules.js`, `sync.js` and `tests.js`, so a second global reference would throw there rather than politely fall back.
- **Rooms delete themselves in exactly two cases** (`roomIsSpent`, applied inside `leave`'s transaction). A room whose second seat was never claimed and which therefore has no `state` at all — the lobby creates one every time somebody starts *searching* rather than every time a game happens, so most rooms are advertisements nobody answered — and a game with a winner that both players have deliberately left, `departed` being set only by Exit and cleared by `attachPresence` whenever a seat is reoccupied, so it cannot fire on someone whose train went into a tunnel. **An unfinished game is never removed, however thoroughly both players walk away from it**: that is precisely what Rejoin exists to get you back into. Nothing else deletes rooms, and no client should — there is no listing, and removing somebody else's game is not a client's business. General cleanup remains a console job.

  `roomIsSpent` is pure and reads only `seats`, `departed` and `state.winner`, all of which look the same raw as deserialized, so the same function serves the transaction (Firebase's shape) and `exitToStartScreen` (`script.js`'s). The second caller is what stops the start screen offering "Rejoin room ABCDEF" for a room it just deleted — asked *before* leaving, since leaving is what removes the answer. The residual cost, accepted: the deletion cannot reach the *other* player's storage, so whoever left first may still be offered a room that is gone. Pressing it puts them alone in a fresh empty room of the same name — one confusing screen, no worse than typing a code at random.

  **A `set`, `update` or `remove` anywhere on a pending transaction's path — ancestor or descendant — cancels that transaction**, and Firebase reports it as an error whose entire message is the name of the offending operation ("set"). This is why `attachPresence`'s detach no longer removes the presence entry and the transaction clears it instead: removing it alongside a transaction on the room above killed the transaction every time, silently, and the room was simply never cleaned up. Found against the live database after the suite passed; `createFakeDatabase` now models it (see Tests).

- **Departure** (`leave({ departed: true })`) writes `departed/<color>` and is what separates "they quit" from "their connection dropped". Both end with the presence entry gone, so without it the room record is identical either way and the opponent gets told "opponent disconnected" in both cases — the wrong thing to say to someone whose opponent pressed Exit and is not coming back mid-turn. `attachPresence` clears the flag whenever that seat connects, so returning to a room cancels the announcement without any separate bookkeeping. A plain `leave()` (the teardown path) deliberately does *not* set it, and a spectator never does — there is no seat anyone is waiting on. `renderRoomStatus` checks `departed` **before** presence, since leaving clears presence too and the more specific case has to win. Exiting does not free the seat: seats are never released in this design, and seat recovery (above) depends on that, so coming back to the same room reclaims the same seat rather than finding a stranger in it.
- **Identity** (`identityFor`) returns two things: `clientId`, stored in `sessionStorage` and deliberately not `localStorage` (`localStorage` is shared across every tab of one origin, which would make two tabs open to the same room collapse into a single client unable to hold two seats — `sessionStorage` is per-tab, so a reload of the same tab reclaims its seat and a genuinely new tab gets a new one); and `recoveredClientId`, which exists because that per-tab guarantee costs a mobile player their game. A browser discarding a backgrounded tab discards its `sessionStorage` too, so a player returning hours later arrived as a new client, found both seats still claimed (seats are never freed) and was demoted to spectator — locked out by `blockedOnline()` with no way back except hand-editing the room code off the URL. The id is therefore *also* mirrored to `localStorage`, and when `sessionStorage` comes up empty that mirror is passed to `claimSeat` as a **candidate**: a claim to a seat, not an identity, honoured only if that seat has no `presence` entry right now. Presence is the only thing separating "returning to a seat nobody is sitting in" from "a second tab opening beside a live one" — the room record is otherwise identical, since the second tab finds the same mirrored id. Both halves are one function on purpose: the mirror must be read *before* `sessionStorage` is written, and splitting that across two calls would silently disable recovery with nothing failing loudly. Accepted limitation: the mirror holds one id per room, so two tabs of one browser in the same room leave the first unable to recover — a testing shape, not how two people play.
- **`onRoom(room, color)`** fires for every room change, whether this client caused it or another one did — Firebase's `on('value', ...)` echoes a client's own writes back to itself, so there's exactly one "the room changed, react to it" path, not a separate optimistic-update path for the sender.
- **`commitState`** in `script.js` is the only place `state` gets reassigned; it either applies locally (hot-seat) or calls `sync.js`'s `sendState` (online), which itself round-trips back through `onRoom` to actually update `state` and render — so a local move and a remote one are indistinguishable by the time they reach rendering.
- **A game with no room code in the URL never calls `sync.js`'s Firebase-touching code at all** — `defaultDatabase()` (which calls `firebase.database()`) is only reached if `database` isn't injected, and `joinRoom` is only called once a player has chosen to play online: Find an opponent, Rejoin, a typed code, or an existing `#room=` in the URL. A hot-seat game touches none of it.
- **`database.rules.json`** restricts read/write to a specific `/rooms/<code>` path, and only if you already know the code — there's no listing, no accounts. This is friend-level trust: any seated client can write anything to its own room; nothing is validated server-side.

## Tests

`tests.html`/`tests.js` — no framework, no build step. Covers `rules.js` (pure functions, straightforward) and `sync.js` (against a small in-memory fake of the handful of Firebase calls it makes — `ref`/`transaction`/`on`/`off`/`set`/`update`/`remove`/`onDisconnect`, plus `.info/connected` — injected via `joinRoom`'s `database` option, so the suite has no live network dependency and isn't testing Firebase itself, only how this code uses it). The fake resolves everything asynchronously on purpose, which is what makes the concurrent-seat-claim test meaningful. Its store is a real nested tree, not a flat map keyed by path string — a write to a child path (e.g. presence, at `rooms/<code>/presence/<color>`) has to be visible to a `'value'` listener on the parent room path, same as real Firebase, and a flat map can't do that. A test-only `db._simulateDisconnect(path)` runs whatever `onDisconnect()` action was registered at that path, standing in for the server noticing a real connection drop (which nothing client-side can trigger for real). The fake also **resolves `ServerValue` sentinels on write**, as the real database does — storing `{ '.sv': 'timestamp' }` verbatim would let a test pass while Firebase wrote something quite different, the same class of gap `stripNulls` exists to close. `db._serverTime` pins that clock, which is what makes "this came from the server, not the client" assertable: a pinned value is one no client-side `Date.now()` could have produced.

The fake also **reorders keys the way Firebase does** (`firebaseKeyOrder`) and **cancels a pending transaction when an overlapping write lands on it** (`_oneConnection`). Both were added after a bug got past the suite and had to be found against the live database — the same reason `stripNulls` and the `ServerValue` resolution exist, and the standing lesson here: a fake that only does what you would naively expect is where these bugs hide. Transaction cancellation is **off by default**, and that is honest rather than a shortcut. Firebase aborts a transaction only when *the same client* writes over its path; a write from another client just makes it re-run, which is the retry mechanism seat claiming depends on. This fake has one store and one set of refs and cannot tell the two apart, so tests exercising a single client set `db._oneConnection = true`, and tests standing two devices against each other leave it off.

`tests.html` loads its scripts with a cache-busting timestamp appended to the URL, because plain `<script src>` tags can serve a stale cached copy over `file://` in some sandboxed browser tooling even after the file on disk has changed — if you ever see a test result that doesn't match a change you just made, suspect this before suspecting the code, and try a hard reload or a `fetch()` + `eval()` of the file's current contents to rule it out.

Running `tests.html` inside a sandboxed/automated browser tab (as opposed to a normal foregrounded tab) can produce flaky failures in the async `sync.js` tests that have nothing to do with the code: a backgrounded tab (`document.hidden === true`) gets Chrome's aggressive background-timer throttling, which can push a test's `waitFor` past its budget purely from scheduling delay. Confirm before suspecting a real bug — reproduce the same failures against an unmodified checkout (e.g. `git stash`) first, or just sidestep the whole issue with `run-tests.js` (below).

`run-tests.js` runs the same suite under `jsc` (macOS's command-line JavaScriptCore, no browser involved) instead of `tests.html`, for a clean, fast, non-flaky result whenever you need to double-check a `tests.html` run:

```bash
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc run-tests.js
```

The `run-tests` skill (see Skills below) wraps exactly this invocation and is the preferred way to run it. Run from the repo root, since `load()` resolves `rules.js`/`sync.js`/`tests.js` relative to cwd. It stubs `document`/`sessionStorage`/`firebase`/`window` (jsc has none of them) plus a minimal virtual-time `setTimeout`/`Date.now` (jsc has no timers at all, and the suite's `waitFor` needs them), then reports the same pass/fail summary `tests.html` would, exiting non-zero on any failure so it's usable as a pre-commit check. If a change to `rules.js`/`sync.js`'s shape ever breaks one of these stubs, the failure mode is a hang followed by "NO RESULTS", not a wrong pass/fail count.

## Skills (`.claude/skills/`)

Three project skills wrap the manual routines above so they're one command instead of something to remember. Each is a `SKILL.md` plus a `scripts/` shell script; the script is the real logic, so it's runnable directly (`bash .claude/skills/<name>/scripts/<script>.sh`) without going through the skill. `.claude/` is deliberately tracked in git so these ship with the repo — only `.claude/launch.json` and `.claude/settings.local.json` are ignored, since they hold machine-specific paths and permissions.

- **`run-tests`** — runs the suite under `jsc` (the `run-tests.js` path above), which is the reliable way; prefer it over `tests.html` and over composing the raw `jsc` invocation by hand. Its SKILL.md explains what a hang or "NO RESULTS" actually means, so don't reinterpret one independently.
- **`cache-bust-check`** — compares which of the seven versioned assets have uncommitted changes against whether `index.html`'s `?v=N` tags were touched too, exiting non-zero if a bump was missed. It only verifies that *some* bump happened, not that all seven tags stayed in sync — still confirm all seven show the same new number by eye. The icon PNGs are deliberately outside this set: they are immutable in practice, and a stale icon is cosmetic where a stale script is the mixed-old-and-new state the scheme exists to prevent.
- **`ship-check`** — the pre-push gate: runs the two skills above, greps `rules.js` for DOM references (enforcing the purity split described under Architecture), and warns if the push carries changes to documented files without touching `CLAUDE.md`/`README.MD`. The first three gates fail hard; the docs gate only warns, because whether a doc is genuinely stale is a judgement call a script can't make. Run it immediately before `git push`.

When one of these routines changes, update both the script and its `SKILL.md` — the SKILL.md is what a future session reads to decide *whether* to run it, and a script whose description no longer matches simply stops being invoked at the right moments.

## Where things are documented

`README.MD` has the project's own build plan (stage-by-stage history), a running Future Improvements backlog, and a Status section — check it for what's already been decided or deliberately deferred (e.g. no doubling cube, no AI opponent) before re-proposing those.
