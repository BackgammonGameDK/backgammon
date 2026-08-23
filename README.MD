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
   - ~~**Rejected clicks are silent.**~~ ✅ Done. `selectionProblem` in
     `rules.js` says which of the four rules refused a click — wrong
     colour, dice not rolled, a checker waiting on the bar, or nowhere to
     go — and `script.js` turns the code into a sentence. It belongs in
     `rules.js` because it is a rule rather than presentation, which also
     makes the reasons testable without a browser; `canSelect` is now just
     that function returning null. Ordered most fundamental first, and only
     spoken when the click actually landed on something, since answering
     taps on the bare board would be noise.
   - ~~**No hit announcement.**~~ ✅ Done, by two different routes. The
     player doing it reads `applyMove`'s `hit`; the player it happens to is
     told by comparing the arriving state's bar against the previous one
     (`wasHit`), because nothing in the broadcast says a hit occurred — the
     board simply changes underneath them.
   - ~~**Turn indicator is stale after a win.**~~ ✅ Done — it reads "Game
     over" instead. It says something rather than emptying because
     `.status-row`'s height is part of the board's hand-measured budget.
   - ~~**The skip message and the reason for it disappear together.**~~
     ✅ Done. `showMessage` gained a sticky mode that skips the three-second
     clear, and the skipped-turn notice uses it: it now waits for the
     player's next action instead of a clock.
   - **The board is keyboard/screen-reader unreachable.** The buttons are
     all real `<button>`s and reachable — Find an opponent, Play on this
     device, Rejoin, the code field and Join, Hints, Roll, Undo, Exit,
     Restart — but the board itself is not: points and checkers are plain
     unlabeled `div`s with no role or `tabindex`, so a keyboard-only player
     can roll the dice and never move a checker. The only item left in this
     list, and not really a papercut: closing it means a focus order across
     24 points, roles and labels that say what each point holds, and a
     select-then-move keyboard flow — a feature the size of the rest of
     this list combined, and it wants its own test plan.
   - ~~**Latent:** `animateMove`'s FLIP transform cleanup.~~ ✅ Done — it
     now also clears on a timeout, rather than depending on
     `requestAnimationFrame` and `transitionend`, neither of which fires in
     a hidden tab.
   - ~~**Minor:** `selectedFrom` cleared inconsistently.~~ ✅ Done —
     `commitState` clears it for both branches, so it is no longer each
     caller's job.
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

5. **Onboarding and session recovery**, planned in stages. Prompted by playing
   the deployed game on a phone: a first-time visitor lands mid-hot-seat-game
   with dice already rolled and no signal that online play exists; an online
   game's first roll arrives pre-rolled rather than being something either
   player did; and coming back to a room after leaving the browser for a day
   leaves you unable to play in it, with no way out except hand-editing the
   room code off the end of the URL — cumbersome on a phone, which is where it
   happens. The stages below are ordered so each one has somewhere to put the
   next: 5a is an independent live bug, 5b creates the screen 5c and 5d need
   to exit and return to, and 5e is the largest change and wants the mode
   choice from 5b to already exist.

   - **5a. Reclaim a seat after a mobile tab is discarded.** ✅ Done. A tab's
     identity lived in `sessionStorage` (`clientIdFor`, `sync.js`), which mobile
     browsers discard along with a backgrounded tab. Returning later rejoins
     with a fresh client id, finds both seats still held by the old ids (a
     seat is deliberately never freed), and is demoted to spectator — at
     which point `blockedOnline()` blocks everything and the room looks dead.
     Keep `sessionStorage` as the primary identity (it is what lets two tabs
     on one machine hold both seats, and that is the whole reason it was
     chosen over `localStorage` — see Architecture), but also write a
     recovery copy to `localStorage` keyed by room code. On a join that finds
     `sessionStorage` empty, offer the recovered id to the seat-claiming
     transaction as a *candidate*, to be adopted only if that seat currently
     has no presence entry. That distinguishes the two cases correctly: a
     player returning a day later reclaims their seat because their old
     presence is long gone, while a second tab opened on the same machine
     does not steal seat one, because that tab is still connected. Testable
     against the existing in-memory database fake.

     Built as described: `clientIdFor` became `identityFor`, returning
     `{ clientId, recoveredClientId }` as one function rather than two,
     because the mirror has to be read before `sessionStorage` is written
     and splitting that across two calls would silently disable recovery
     with nothing failing loudly. `claimSeat` takes the candidate and
     consults `presence` to decide. Covered by 11 tests written before the
     fix, seven of them failing until it landed.
   - **5b. Start screen as the entry point.** ✅ Done. Replaced "boot straight
     into a hot-seat game, with Play Online as one more button in the dice area"
     with an explicit choice between playing on this device and playing
     online (create a room, or join by code). Two constraints: a URL that
     already carries `#room=CODE` must skip the start screen and join
     directly, or every invite link and QR code gets worse; and
     `createInitialState()` currently runs at module load in `script.js`,
     so the opening roll is generated before the player has chosen anything
     — that has to be deferred until a mode is picked, or the "why are there
     already dice?" confusion just moves behind one click. The overlay can
     reuse the `#celebration` pattern rather than introducing a new one.

     Built as described. Two things came out of it that the plan didn't
     anticipate. Validation errors had to move to a `#start-error` inside
     the panel: `showMessage` writes into `#message` down in the dice
     area, *behind* the overlay, so a rejected room code set text nobody
     could see and the screen simply looked unresponsive — caught while
     testing the screen, not by reading the code. And moving the join
     controls out of `.dice-area` left `.online-area` holding only
     `#room-status`, which measures the same height the old
     `#pre-join-area` row did, so `--chrome` is unchanged and still right
     for online play — but a hot-seat game now leaves that row empty, and
     the slack it left was reclaimed in a follow-up (see Status).
   - **5c. Exit to the start screen.** ✅ Done. A button that leaves the
     current game and returns to 5b's screen, clearing the room from the
     URL. Depends on 5b for a destination. Once 5a is in, this is a
     deliberate "I am done with this game" rather than the recovery
     mechanism it would otherwise have to be.

     Built with one addition to the plan: leaving now *announces* itself.
     A deliberate exit and a dropped connection both end with the same
     presence entry gone, so the opponent was told "opponent disconnected"
     either way — wrong for someone whose opponent has actually quit. The
     room record gained a `departed` flag, set only by Exit and cleared
     whenever that seat reconnects, so the status line can say "opponent
     left the game" instead. Exit deliberately does *not* free the seat:
     seats are never released in this design and 5a's recovery depends on
     that, so returning to the room reclaims the same seat.
   - **5d. Rejoin the last room from the start screen.** ✅ Done. Remember
     the last room code and offer it as a button on 5b's screen. Falls out
     of 5a and 5c almost for free, and is what actually removes the
     hand-edit-the-URL step for a returning player.

     Two things worth recording. The storage read is wrapped in try/catch
     where `identityFor`'s deliberately isn't: this one runs on *every*
     page load rather than only when joining a room, and Safari's private
     mode has historically thrown on storage access — an unguarded read
     would take the whole app down for someone who only wanted a hot-seat
     game. And the start panel gained a row, which stopped fitting a
     landscape phone once the Rejoin button was showing; the landscape
     breakpoint was tightened so the fullest case fits without scrolling
     at 300px of height, below any real phone.
   - **5e. Manual opening roll.** ✅ Done. `createInitialState()` returned a state that
     already contains the opening roll and both pre-loaded dice, so neither
     player ever rolls for the start — fine as a faithful implementation of
     the standard opening procedure, confusing as the first thing you see in
     a game you just joined. Make it interactive instead: an opening phase in
     which each seated player rolls their own die, ties visibly reroll, and
     the higher roll's turn then begins pre-loaded with both values exactly
     as it does today. This is the largest of these stages because it adds a
     genuine new phase to `rules.js`, which ripples into `blockedOnline()`
     (during the opening phase *both* players must be able to act, not only
     `currentPlayer`), the seeding branch in `handleRoomUpdate`, `renderDice`
     and the Roll button, and the test suite. It also strengthens the
     re-roll-until-favorable concern `bothSeatsClaimed` exists for: if each
     player rolls their own die, neither can re-roll the other's.

     Built as described. `state.phase` was added rather than deriving the
     phase from `openingRoll`'s contents, and a tie is deliberately left on
     screen so both players see the round they lost. The sharpest surprise
     was serialization: a fresh opening roll is `{ white: null, black:
     null }`, which Firebase stores as *nothing at all*, so a joining
     player received a state with no `openingRoll` key — `deserializeState`
     now puts both keys back explicitly during the opening phase. Three
     round-trip tests cover it, and disabling the fix fails exactly those.

6. Further online-play UX, noted during the same review. Independent of each
   other and of the stages above, listed roughly by value per unit of effort.
   Separate from the playtest findings in item 3, which are still open too.
   - ~~**Draw the board from Black's perspective online.**~~ ✅ Done. Black
     played on a board laid out from White's point of view, moving "upward"
     toward a home board in the top right; a `.black-perspective` class on
     `.board` now swaps the two rows for a client seated as Black, which is
     the whole mirror. Purely a rendering concern, as predicted — the
     absolute 1-24 numbering in `rules.js` is untouched, and two clients in
     one room were verified to hold byte-identical `state` while their
     boards differ. Done with flex ordering rather than a transform on
     purpose: a `scaleY(-1)` would invert the coordinate space the FLIP move
     animation measures in and mirror the count badges' text.
   - ~~**A "your turn" cue for a backgrounded tab.**~~ ✅ Done, via
     `document.title` — which now reads "● Your turn — Backgammon" (or
     "● Your roll" during the opening) whenever the game is waiting on you.
     The `navigator.vibrate` half of the idea turned out to be a dead end:
     the spec has vibration ignored while the document is hidden, which is
     exactly the case worth signalling. The Notifications API would reach a
     backgrounded phone properly, but wants a permission prompt and an
     installed PWA on iOS — left for later if the title proves too quiet.
     Note the title's own limit: a browser that discards a backgrounded tab
     stops running the page, so this helps while you are briefly in another
     app, not when you return the next day.
   - ~~**Undo the last move within a turn.**~~ ✅ Done. The stack turned out
     to be the easy half; the interesting part was making it safe. Each
     entry stores the state before its move *and* a snapshot of the state
     after it, and an undo is only offered while the live board still
     matches that snapshot — so a history left stale by the opponent
     restarting mid-turn can never be committed and resurrect a dead board.
     Undo is refused during the opening phase (that would be re-rolling for
     who starts) and once a turn has ended (the opponent may already be
     acting on it). Online it broadcasts, so the opponent sees the checker
     go back, which is what taking a move back looks like across a real
     board.
   - ~~**Room lifecycle.**~~ ✅ Partly done — the timestamp half.
     `lastActive` is now written on every state broadcast, using Firebase's
     server-timestamp sentinel rather than `Date.now()` so a device with a
     wrong clock cannot make a dead room look fresh. Nothing writes it on
     join, so a room whose second player never arrived has no `lastActive`
     at all, which says something more useful than a timestamp would: never
     played, rather than played and gone quiet.

     **Deleting is still not done, and cannot be from the client:**
     `database.rules.json` grants access only to a room whose code you
     already know, there is no listing, and no client has any business
     removing someone else's room. Cleanup is a Firebase-console job until
     there is a scheduled one, which needs the paid plan. What this stage
     buys is that stale rooms are now *identifiable*.

     One cleanup a client genuinely could do, deliberately left out: when a
     game has a winner and both players have pressed Exit, the second one
     to leave could delete the room outright — both conditions are already
     in the record (`state.winner` and the two `departed` flags), and
     `remove()` is idempotent so a race is harmless. Left out because
     deleting is destructive and someone may want to reopen a finished game
     to look at the final board.

7. **Matchmaking lobby** — pair two people who are looking for a game at the
   same time, instead of requiring one of them to send the other a link.
   Planned but deliberately not scheduled: unlike items 5 and 6, which
   remove friction from things the game already does, this adds a
   capability it doesn't have, and drags the project's trust model along
   with it. Two things to settle before the code matters.

   **Population.** A queue only works if someone else is in it. This is a
   personal project shared with friends, so the realistic queue depth is
   zero nearly all the time — and an empty lobby fails *silently*, which is
   worse than it sounds: a first-time visitor taps "Find an opponent",
   waits, nothing happens, and concludes the game is broken. An invite link
   never does that; it either works or it's visibly obvious the other
   person hasn't opened it yet.

   The mitigation, settled on before starting: **make an empty queue
   degrade into the flow that already works.** Three parts.

   Show the real count rather than a spinner — `/lobby` has to be
   world-readable for matchmaking at all, so a waiting client can simply
   count the other entries and say "nobody else is looking right now" or
   "1 other person searching". That is a status which tells you something,
   rather than one that merely proves the page hasn't frozen.

   Offer the invite link *in* the waiting state, with the existing Copy
   link and QR controls. If nobody is queuing, the useful action is not to
   keep waiting but to send a friend the link.

   And create the room when someone starts **searching**, not when they are
   matched. Then there is one waiting state and either kind of opponent
   resolves it — somebody paired from the queue, or a friend opening the
   link — whichever arrives first. The lobby stops being a separate mode
   and becomes another door into the room you are already sitting in.

   One consequence to plan for: rooms would then be created by searching
   rather than by playing, which is a great many more rooms. That is part
   of why `lastActive` landed first, and why a never-played room carrying
   no timestamp at all turns out to be the right signal.

   **Strangers versus the trust model.** The decision recorded under item 2
   — friend-level trust, each client validating only its own moves, with
   `database.rules.json` restricting writes to a room whose code you
   already know rather than to whose turn it is — is exactly what
   matchmaking invalidates. `sendState` broadcasts whole state snapshots
   and any seated client may write anything, so a matched stranger can set
   `winner` to their own colour, move the opponent's checkers, or hand
   themselves any dice. Nobody does that when you chose your opponent;
   somebody eventually will when the app chooses for you. Matchmaking is
   the change that turns a reasonable simplification into an exploitable
   one.

   **The mechanics themselves are the easy part**, and reuse machinery that
   already exists. A `/lobby/waiting/<clientId>` entry per searcher;
   pairing decided by a Firebase transaction, since two players who spot
   each other simultaneously must not both claim (the same race
   `claimSeat` already solves, with the same tool); the claimer generates a
   room code, writes it into both entries, and both clients navigate to
   `#room=<code>`, from which the existing flow is untouched. Stale entries
   clean themselves up through `onDisconnect().remove()`, the same idiom
   `attachPresence` uses, so closing the tab leaves the queue automatically.

   The genuinely new requirement is that `/lobby` be world-readable and
   world-writable, since there are no accounts — the first thing in the app
   a stranger can touch. Database rules can validate an entry's *shape* but
   not its *volume*, so nothing would stop someone flooding the queue.

   Suggested sequence, if it's built — **7b first, then 7a**, which
   reverses the obvious order deliberately. The biggest open question about
   the whole feature is whether anyone is ever *in* the queue, and 7a is
   pure infrastructure that answers nothing; building it first would mean
   hardening a feature before knowing whether it is worth having. With the
   graceful degradation above, a null result costs the user nothing.

   Two things make deferring auth acceptable rather than reckless: a
   griefed lobby does not touch existing games, since rooms live under a
   separate path with their own rules, so the blast radius is the queue
   node; and database rules can still validate the *shape* of a queue entry
   without identity — enough to stop `/lobby` being used as free storage,
   even if not enough to stop volume.

   - **7a. Firebase Anonymous Auth.** Every client silently gets a UID — no
     signup, no build step, one more `-compat.js` script. It's what makes
     a rule like "you may only write your own queue entry" enforceable
     rather than aspirational. Best treated as the hardening step the
     lobby earns once it has proved it attracts anyone at all.
   - **7b. The lobby.** ✅ Done. The transaction-based pairing above, with
     honest queue-state UI rather than an indefinite spinner. "Start an
     online game" became "Find an opponent", and now looks for someone
     already waiting before starting a room of its own; the waiting line
     reads "waiting; nobody else is searching" or "…; 1 other searching",
     with Copy link and QR beside it so an empty queue degrades into the
     invite flow exactly as planned.

     Two findings worth keeping. A claim must **not** abort its transaction
     when the current value is null: Firebase runs the update function
     optimistically against its cache before it has the server's value, so
     null there means "not fetched yet", not "already taken" — aborting
     kills the transaction before it reaches the server and claiming
     silently never works. It cost a live debugging session precisely
     because no fake that hands over the true value on the first call can
     reproduce it, so `createFakeDatabase` now simulates that optimistic
     pass and honours an abort during it; re-introducing the bug fails four
     tests. And the longer waiting text pushed `#room-status` 2px taller at
     narrow widths, so `--chrome` and `--online-row` were re-measured
     together at that breakpoint — which leaves a hot-seat board unchanged,
     since it spends the difference between them.
   - **7c. Validate incoming state in `rules.js`.** ✅ Done. Rather than
     trusting a received snapshot, each client checks it is a legal
     successor of the state it already had. `isStructurallyValid` judges one
     state on its own — fifteen checkers a side, possible dice, a winner who
     has actually borne off fifteen — and `isLegalSuccessor` compares two,
     monotonically: the idle player cannot have gained ground, the player on
     turn cannot go backwards or bear off more than a turn's worth.

     Undo is handled by memory rather than by reasoning backwards: it
     reverts to a state broadcast moments ago, so the last eight accepted
     states are kept and a match is accepted, which covers Firebase echoing
     a client's own writes as well.

     Two bars, not one. A structurally impossible board, or an unexplained
     win, is refused outright and never resynchronised past — no missed
     traffic can produce either, and being talked into a loss you cannot
     verify is the worst outcome available. Anything else is refused only
     until three *distinct* unexplainable states have arrived, at which
     point the client accepts and resynchronises: falling behind is far
     likelier than being attacked, and a permanently wedged game is a worse
     harm. Distinct rather than a count means resending one rejected board
     gets nowhere.

     As predicted, this does not stop a determined attacker; it stops the
     crude version and catches desync bugs. Verified against a real second
     client attempting fabricated wins.

   Finish items 5d and 5e first regardless. 5e collides with this
   specifically: once both players must roll to start, a stranger who
   matches and never rolls blocks the game, so matchmaking would need a
   turn timeout — something the app has nowhere else.


8. Further ideas noted once the onboarding work (item 5) was finished and the
   game had been played through properly. Independent of each other.
   - ~~**Confirm before Restart — arguably a defect, not a feature.**~~
     ✅ Done. A mid-game Restart now arms on the first press and acts on the
     second, showing "Restart?" in amber. It disarms after four seconds, and
     also on any state change at all — the confirmation was armed over a
     particular board, and if that board has moved on the second tap would
     be answering a question nobody is asking. A finished game, or one still
     deciding who starts, restarts on the first press; Play Again on the win
     overlay never asks, a new game being the whole point of that button.

     Not solved: **the other player still gets no say.** One player's
     confirmed Restart ends the other's game without warning. A restart
     *request* that the opponent accepts is a larger feature; this stops the
     accident, not the disagreement.
   - **A connection indicator.** If a phone loses signal mid-game nothing
     says so — moves simply fail to broadcast, silently. `sync.js` already
     watches `.info/connected` for presence, so surfacing "offline —
     reconnecting" is mostly a matter of exposing something that is already
     observed. Aimed at the same mobile-online situation item 5 came out of.
   - **Gammon and backgammon scoring, and match play.** Every win is
     currently worth the same and the game simply ends. Standard backgammon
     scores a gammon double (the loser has borne off nothing) and a
     backgammon triple (they also still have a checker on the bar or in the
     winner's home), and is played to a target score rather than a single
     game. This is pure `rules.js` work — the shape that file is built for,
     and straightforwardly unit-testable — and it is probably the largest
     remaining gap between this and a real backgammon game. Distinct from the
     doubling cube, which is deliberately out of scope.
   - **Flip the board in hot-seat too.** A rotate control, so two people
     sitting opposite each other at one tablet can each play from their own
     side. The machinery already exists — `setBoardPerspective` is a single
     class toggle — so this is mostly a question of where the control lives
     and whether it should persist.
   - **A move log.** A compact record of recent turns ("Black 13→7, 8→7").
     It would quietly settle three of item 3's findings at once — no hit
     announcement, the skip message vanishing along with the reason for it,
     and the general "what just happened?" problem online, where the board
     changes with no account of why.
   - **Persist a hot-seat game across a reload.** Online games survive
     because Firebase holds the state; a hot-seat game lives only in memory
     and dies on refresh. `state` is already JSON-serializable, so this is
     `localStorage` plus a decision about when to clear it.

   Also noted while building the "your turn" tab-title cue (item 6): the
   **Notifications API** is the only thing that would actually reach a phone
   whose browser is in the background, which the title cannot do. It needs a
   permission prompt and, on iOS, the site installed to the home screen as a
   PWA — a real feature rather than a tweak, worth reaching for only if the
   title proves too quiet in practice.

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

*A running log rather than a summary, and not strictly ordered: the oldest
entries are at the top, but everything since the multiplayer work was added
newest-first below them. Where a later entry supersedes an earlier one, the
earlier is marked. For what is true right now, Architecture and CLAUDE.md
are the reliable places.*

✅ Core build plan complete — stages 1-7 (including 5a and 5b) are all done: static board, checker movement, dice rolling, move legality, turn structure, dimmed used dice, bar re-entry, bearing off, win detection, and restart. The game is fully playable end to end.

Since then: Restart was separated from Roll to prevent mis-clicks, a "Hints" toggle was added to highlight a selected checker's legal destinations on request, a checker with no legal moves can no longer be selected at all, a pip count display (shown when Hints is enabled) was added, checkers now animate (slide) into place instead of jumping, the legal/invalid highlight colors were made colorblind-safe (blue solid ring vs. orange dashed ring, instead of red/green), black checkers got a lighter border so they're visible on the bar/off-tray, and the legal-target blue was softened to fit the board's wood-tone palette better.

The game state was then extracted out of the DOM into `rules.js` (see Architecture), with a test suite covering the rules — groundwork for multiplayer. Restart is now a state reset rather than a page reload.

A "Play Online" button lets players share a live game via a room code in the URL (`sync.js`) — first to join is White, second is Black, further joins spectate. Moves, rolls, and restarts made by one player appear for the other automatically. First built and proven between two tabs on one machine with no backend at all, then backed by a real Firebase Realtime Database — the transport swap only touched `sync.js`, nothing else. Two separate devices, anywhere, can now play the same game.

The game is also published online (GitHub Pages) and the layout is now responsive: the board keeps its 950x640 proportions but scales to fit the screen, with everything inside sized as a percentage of it. Desktop is unchanged at full size; phones get a compacted dice area, proportionally larger checkers, and a nudge to rotate to landscape, where a 24-point board has far more room.

Two polish passes since: the board's height-aware sizing (previously phone-only) now also applies on desktop, so a browser window that isn't maximized shrinks the board to fit rather than running it off the bottom of the screen; and `#message`/`#game-over` no longer reserve empty space when there's nothing to show, closing what had become a visible gap between Roll and the board. A win now shows a dismissible full-screen celebration (confetti, a "Play Again" button) on top of the existing small status line, rather than only the status line.

The playtest papercuts were then cleared out, all but the accessibility one. A refused click now says why — wrong colour, dice not rolled, a checker waiting on the bar, or nowhere to go — with the reasons living in `rules.js`, since what stops you picking up a checker is exactly what the engine already knows. A hit is announced to both players, the one it happened to being told by comparison rather than by the broadcast, which says nothing about it. The turn indicator stops claiming a turn once the game is over. And the skipped-turn notice waits for the player's next action instead of a three-second timer, which had been clearing the explanation at the same moment the dice cleared the evidence. Two long-standing hygiene items went with them: the checker-slide animation no longer depends on callbacks a hidden tab never fires, and clearing the selection is now `commitState`'s job rather than each caller's.

With strangers now able to reach a room, arriving states are no longer taken on trust. Each client checks that what it receives could actually have happened: fifteen checkers a side, possible dice, nobody bearing off on someone else's turn, and no winner who has not borne off fifteen. An impossible board, or a win that cannot be accounted for, is refused outright; anything else is refused only until it becomes clear the client has simply fallen behind, since a permanently stuck game is a worse outcome than an unpunished cheat. Undo is recognised by remembering recent states rather than by reasoning backwards through a move. None of this stops a determined opponent — it stops the crude version, and catches genuine desync bugs on the way.

The start screen and the board were then rebalanced around that. Finding an opponent is the ordinary way to play now, so it leads and is the only filled button; hot-seat and Rejoin are outlined beneath it, and the room-code field folds away behind a quiet "Have a room code?" toggle, codes being a fallback for someone who was sent one rather than something everyone should read past. The room status row went the same way: it now earns its space only while it has something to say — waiting for an opponent, or one who disconnected or left — and disappears during an ordinary game, where the code is in the address bar anyway. The board grows into that space, about 56px wider at desktop, and the row comes back by itself when there is news, bringing Copy link and QR with it exactly when re-inviting someone is what you want.

Two people who both press "play online" now end up in the same game. Previously they each got a random room code and waited for each other forever; the lobby advertises rooms wanting a second player, so the first searcher creates a room and waits in it, and the next one joins them. The room is created when you start searching rather than when you are matched, which means one waiting state covers both ways an opponent can arrive — claimed from the queue, or through the invite link sitting right beside the waiting text. An empty queue says so plainly rather than spinning.

Restart now asks twice. It wipes a game in progress for both players, either of them can press it at any time, and unlike Exit it cannot be undone — the start screen can offer a room back, but not a board. Mid-game it arms on the first press and acts on the second, disarming after four seconds or on any state change, since a confirmation armed over one board should not still be live over a different one. A finished game restarts on the first press, and Play Again never asks at all. What this fixes is the mis-tap; it does not give the other player a say, which would need a restart request they accept.

Rooms now record a `lastActive` timestamp on every broadcast, so a stale one can be told from a live one. It uses Firebase's server clock rather than the device's, since a phone with the wrong time would otherwise make a dead room look fresh; and nothing writes it on join, so a room whose second player never showed up has no timestamp at all — which says "never played" rather than "played and went quiet". Deleting rooms is still not possible from the client, and deliberately so: the database rules grant access only to a room whose code you already know, so cleanup remains a console job until there is a scheduled one.

The last move of a turn can now be taken back, restoring the board and the die it used — mis-taps being easy on a phone-sized board. The undo stack lives in the UI rather than in the game state, since it is nobody else's business, and each entry carries a snapshot of what the board looked like just after its move: an undo is only offered while the live board still matches, so a history left stale by the opponent restarting mid-turn can never be committed. It is refused during the opening roll, which would otherwise be a way to re-roll for who starts, and once a turn has ended. The button shares Roll's row rather than taking one of its own, and is padded to match Roll's height to the pixel, because a taller row would quietly eat into the board's hand-measured height budget.

The tab title now carries the turn, too: while a game is waiting on you it reads "● Your turn — Backgammon", or "● Your roll" during the opening, and goes back to plain once you have played. It is written on every render rather than only when the tab is hidden — a title is a status indicator, not a notification, so it says what is true and clears itself when the turn passes. Vibration was considered and dropped, being ignored by the browser precisely while the document is hidden.

Black now sees the board from their own side online. Backgammon is played across a board — the player opposite has their home board bottom-right and moves toward it — but Black had been playing on White's layout, moving "upward" toward a home board in the far corner. A class on `.board` swaps the two rows for a client seated as Black, which produces the entire mirror at once: home bottom-right, bear-off tray beside it, bar in the row they re-enter into, and their back checkers top-right. The rules never learn about it — both players' state stays byte-identical while their screens differ, so a move means the same point on both sides. It is done by reordering rather than by rotating the board, because a transform would invert the coordinate space the checker-slide animation measures in and mirror the count badges' text along with everything else.

The opening roll is now the players' to make, completing the original set of three complaints. A fresh game contains no dice at all: each player throws one die, the higher starts, and a tie stays on screen — both dice showing the same number — until somebody rolls again. Online, either player may roll first and each is told about their own die ("You rolled 3 — waiting for your opponent"); hot-seat steps through White then Black on the one shared button. `state.phase` distinguishes the two phases rather than the phase being inferred from the roll's contents. The per-player dice colours arrived just in time to carry this: during the opening you see one white die and one black die side by side, which explains the procedure without a word of instruction.

The dice now take the colour of whoever rolled them — white body with dark pips on White's turn, dark body with light pips on Black's — matching how each player has their own pair in a real set, and giving the turn a second, wordless cue beside the turn indicator. Online that doubles as "is it my turn", since you already know your own colour, and the distinction being pure luminance means it survives any colour vision deficiency (the same reasoning behind the blue/orange move highlights). Two things needed care: a black die is `#222` like a black checker, but a checker sits on the wood board while dice sit on the `#2b2b2b` page, where `#222` is nearly invisible — so the border carries the contrast instead and is lighter than the checker's. And the "spent die" cue is a dim to 35% opacity, which reads clearly on a light die but makes a dark one look absent rather than used, so black dice dim less and keep more of their border.

The start screen now also offers the last room this browser was in — *Rejoin room ABCDEF* — which is what makes Exit safe to press, since leaving an online game would otherwise mean needing the invite link again to get back. It is recomputed each time the screen is shown, so the room Exit just left is the one offered and a mis-tapped Exit is one tap from being undone. A first-time visitor never sees the button at all.

An Exit button then completed the round trip: it leaves the current game — hot-seat or online — and returns to the start screen with the room code cleared from the URL, so getting out of a game no longer means hand-editing the address bar. Leaving an online game also announces itself. A deliberate exit and a dropped connection previously looked identical in the room record (both just clear presence), so the opponent saw "opponent disconnected" either way; a `departed` flag, set only by Exit and cleared whenever that seat reconnects, now distinguishes them and the status line reads "opponent left the game". The seat itself is not freed — seats are never released in this design, and coming back to the room reclaims the same one.

The hot-seat board then grew by 57px (~9%) at desktop sizes. `--chrome`, the board's vertical budget, is measured against the tallest state the layout takes — an online game, where `.online-area` holds the room status row — so that the board can never overrun the viewport. A hot-seat game has no room status, so that row is now hidden outright, and `--online-row` (measured per breakpoint, the same by-hand way `--chrome` is) is added back to the budget for hot-seat only. Landscape phones deliberately reclaim nothing, since there the chrome sits *beside* the board and its height was never part of the budget at all. The board's bottom edge lands in the same place in both modes, which is what confirms the reclaimed figure is exactly right rather than merely bigger.

The game now opens on a start screen — at this point offering play on this device, start an online game, or join one by code, with equal weight; **rebalanced later**, once the lobby made finding an opponent the ordinary route in — instead of dropping straight into a hot-seat game with "Play Online" buried among the in-game buttons. Nothing is rolled until a mode is chosen: the board behind the screen is a backdrop with no dice, and picking a mode is what creates the real state, so the first dice you see are ones your own choice produced. An invite link or QR scan carrying `#room=` skips the screen entirely and opens straight into the game.

A player returning to an online game after their mobile browser discarded the backgrounded tab now gets their seat back instead of being demoted to spectator. The tab identity in `sessionStorage` is gone by then, so the client id is mirrored to `localStorage` too and offered to the seat-claiming transaction as a candidate — honoured only if nobody is currently sitting in that seat, which is what keeps a second tab from stealing a live one. Written test-first: 11 tests, seven red until the fix landed.

Online play now tracks presence (see Architecture): the room status line tells "waiting for opponent" (seat unclaimed) apart from "opponent disconnected" (seat claimed, but that player's connection just dropped) — previously indistinguishable, since a seat is never freed once claimed. Verified against the live Firebase project with two real tabs, including a genuine tab-close disconnect.

Joining a room got friendlier: a "Join" field next to "Play Online" takes a typed 6-character room code directly, and a "QR" toggle renders a scannable code for the current link (via a small vendored, dependency-free QR generator — no network call, no external service). Pasting the full invite link still works unchanged; these are additional ways in, not replacements.

A seated player can no longer roll or move before an opponent has actually joined — previously the room creator could start playing solo, since the only existing check was whose turn it was. And who goes first is no longer hardcoded to White: each side rolls one die, the higher roll starts, and that player's first turn is pre-loaded with both individual rolls as its dice — the standard backgammon opening procedure, shown in the turn indicator ("opening roll: White 6, Black 3") and applying to hot-seat play too, not just online. At this point the roll was generated with the board and a tie rerolled itself; **superseded later**, when the roll became the players' own to make and a tie began waiting on screen for somebody to roll again.

The board grows further on desktop now: it was already scaling to fit the window (see above), but on a typical wide-but-not-tall monitor the limit was available *height*, not width, leaving visible unused space on either side. The turn indicator, Hints checkbox, and pip count — three stacked rows — now collapse into one row on screens wider than 900px, freeing up the vertical room the board's sizing math immediately claims. Phones are untouched; they were already width-bound, not height-bound.

The room-status row ("Room XQ57M4 · You are White", Copy link, QR) used to stay put for the whole game, even though it's only actually useful before an opponent has joined. It was made to collapse to a small room-code chip the moment there was nothing left to report, reclaiming that space during play, with the chip reopening the full row as a popover. **Superseded later**: the row is now hidden outright rather than collapsed, and the board takes the height — the code is in the address bar if anyone wants it, so the chip was spending a row on something already available.

Landscape phones got the same board-growing treatment as desktop, but the opposite layout move: rather than collapsing rows into one to free up height (desktop's problem), the dice/status/Roll chrome moves into a sidebar to the *left* of the board instead of sitting in a row above it — a landscape phone is height-limited, so a row above the board was spending the one dimension already in short supply. Freeing that lets the board's existing height-driven sizing grow it substantially; flexbox's normal shrink behavior keeps it from overflowing a landscape window too narrow for that, no extra sizing math needed the way `--chrome` needed for the height axis. Restart joined that sidebar too (moved to the end, with extra spacing) rather than staying fixed in its usual corner — a fixed corner the board doesn't know is spoken for was quietly capping how big it could grow, on top of briefly (and worse) overlapping it outright before that.

The desktop `<h1>` had never actually been styled — it was carrying the browser's default title margins (title case: fine on a generic page, wasteful on one whose whole layout budget is measured to the pixel), noticeably more headroom than the fixed Restart button right next to it uses. Trimmed to nearly match Restart, growing the desktop board a bit further.

Closed a fairness gap in the opening roll: it used to be generated the instant the room's creator opened it, before an opponent had joined, and Restart wasn't gated by opponent presence either — so the creator could sit alone in the room and hit Restart repeatedly, re-rolling the opening dice each time, and stop once one favored them, with nobody there yet to notice. The opening roll is now only generated once both seats are claimed, and Restart/Play Again are disabled (and no-op if triggered anyway) until then.

Testing turned up two real gaps this session: fuzzing `rules.js` (400 random games plus an exhaustive two-dice search, invariant-clean otherwise) found two unenforced dice-obligation rules, logged rather than fixed (see Future Improvements); and driving the actual UI found that points and the bar had the exact same unbounded-pile problem the bear-off tray was fixed for earlier, just never noticed because the standard starting position (5 per point, nothing on the bar) happens to be small enough to hide it. Six or more on a point, or several checkers sent to the bar at once, are both routine mid-game outcomes, not edge cases — past that, two adjacent stacks used to visually merge into one indistinguishable column. Points and the bar now get the identical treatment `MAX_VISIBLE_OFF` already gave the bear-off tray: render only as many whole checkers as fit, show the true count in a badge (`.point-count`, `.bar-count`) once it's needed. Points specifically needed a second, lower cap for once the badge itself is showing (`MAX_VISIBLE_PER_POINT_WITH_BADGE`) — getting that backwards during development capped the *standard opening position itself*, a bug worth flagging for the next round of work like this: measure the count-plus-badge case before assuming a single threshold covers both.

Also added `run-tests.js`, a `jsc`-based runner alongside `tests.html` for the flaky-browser-tab workaround CLAUDE.md's Tests section already described but never had a script for.

Most recently, three of the project's recurring manual routines became skills (see Skills above): running the tests the reliable way, checking the `?v=N` cache-busting bump, and a combined pre-push gate over both plus `rules.js`'s no-DOM rule. The pattern each one addresses is the same — the docs already explained the rule and *why* it mattered, having been written after the bug that taught it, but explaining a rule and enforcing it are different things, and the moment you most need the reminder is the one where you're least likely to go re-read a paragraph about it. The pre-push gate also warns when code the docs describe changes without the docs changing too; it deliberately only warns, since a script can spot the omission but can't judge whether the docs actually went stale. `.claude/` is tracked in git now so these travel with the repo, with the two machine-specific files inside it ignored instead.
