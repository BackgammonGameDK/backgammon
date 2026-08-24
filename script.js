/* DOM wiring and rendering.
 *
 * All game rules and state live in rules.js, which never touches the DOM.
 * This file's job is the other half: turn clicks into moves, and turn the
 * resulting state back into checkers on screen.
 *
 * `state` is the single source of truth - the DOM is derived from it, never
 * read for game logic. `gameStarted`, `selectedFrom` and `hintsEnabled` are
 * the only other local state; `onlineRoom`/`onlineColor` (see the Online
 * play section below) are local too, in the sense that they describe this
 * tab's connection, not the shared game.
 *
 * Every state change - a move, a roll, ending a turn, a restart - goes
 * through commitState() rather than assigning `state` directly, so that
 * hot-seat play and online play are the same code path with one branch:
 * apply it locally, or hand it to sync.js to broadcast.
 */

const board = document.querySelector('.board');
const diceContainer = document.querySelector('#dice');
const rollButton = document.querySelector('#roll-button');
const undoButton = document.querySelector('#undo-button');
const restartButton = document.querySelector('#restart-button');
const exitButton = document.querySelector('#exit-button');
const gameOverEl = document.querySelector('#game-over');
const rotateHintEl = document.querySelector('#rotate-hint');
const turnIndicator = document.querySelector('#turn-indicator');
const messageEl = document.querySelector('#message');
const hintsToggle = document.querySelector('#hints-toggle');
const pipCountEl = document.querySelector('#pip-count');
const playOnlineButton = document.querySelector('#play-online-button');
const startScreenEl = document.querySelector('#start-screen');
const startHotseatButton = document.querySelector('#start-hotseat-button');
const startErrorEl = document.querySelector('#start-error');
const rejoinButton = document.querySelector('#rejoin-button');
const roomCodeInput = document.querySelector('#room-code-input');
const joinRoomButton = document.querySelector('#join-room-button');
const roomStatusEl = document.querySelector('#room-status');
const roomDetailsEl = document.querySelector('#room-details');
const roomInfoEl = document.querySelector('#room-info');
const copyLinkButton = document.querySelector('#copy-link-button');
const qrToggleButton = document.querySelector('#qr-toggle-button');
const qrPanelEl = document.querySelector('#qr-panel');
const qrCodeEl = document.querySelector('#qr-code');
const celebrationEl = document.querySelector('#celebration');
const confettiLayer = document.querySelector('#confetti-layer');
const celebrationMessageEl = document.querySelector('#celebration-message');
const playAgainButton = document.querySelector('#play-again-button');

/* White re-enters on points 19-24 and Black on 1-6, so each colour waits
   on the bar nearest where it will come back in. Keyed on the bar's owner
   rather than which row it sits in: the two rows swap places when the
   board is drawn from Black's side (see setBoardPerspective), and a
   selector that said "top row" would then mean the wrong bar. */
const barContainers = {
  white: document.querySelector('.bar[data-owner="white"] .bar-checkers'),
  black: document.querySelector('.bar[data-owner="black"] .bar-checkers'),
};

const offContainers = {
  white: document.querySelector('.off[data-owner="white"] .off-checkers'),
  black: document.querySelector('.off[data-owner="black"] .off-checkers'),
};

const offCountEls = {
  white: document.querySelector('.off-count[data-owner="white"]'),
  black: document.querySelector('.off-count[data-owner="black"]'),
};

const barCountEls = {
  white: document.querySelector('.bar-count[data-owner="white"]'),
  black: document.querySelector('.bar-count[data-owner="black"]'),
};

/* How many checkers the off tray actually renders, regardless of how many
   are really borne off - .off-count (see renderOffCounts) carries the true
   number past this point. The count badge sits below the checkers as a
   normal flex sibling (style.css), not overlaid on top of them, so it
   needs to be counted as part of what has to fit. Measured, not guessed:
   at a 375px-wide mobile viewport (the tightest case) a checker pile plus
   the badge stops fitting the tray's height past 4 checkers, so 4 is the
   largest count that's safe at every breakpoint - re-measure if
   checker/tray/badge sizing changes. Kept as one constant rather than a
   per-breakpoint value to avoid coupling this file to style.css's exact
   media query breakpoints. */
const MAX_VISIBLE_OFF = 4;

/* Same idea as MAX_VISIBLE_OFF, for the bar - .bar-count carries the true
   count past this point. Measured the same way, at the same 375px
   viewport. A separate constant from MAX_VISIBLE_OFF on principle (the
   bar and the off tray happen to be the same width, but nothing ties
   their measurements together - if either tray's own sizing changes,
   only that one needs re-measuring). */
const MAX_VISIBLE_BAR = 4;

/* Same idea again, for a point - .point-count (appended after the capped
   checkers, see renderOverflowBadges) carries the true count past this
   point. Unlike the off tray/bar, a point's badge is only shown once it's
   actually needed (renderOverflowBadges), not from the first checker -
   with 24 points and most holding a handful in routine play, an
   always-on badge would be mostly clutter rather than the rare exception
   .off-count/.bar-count are. That makes this two numbers, not one: 5
   checkers alone fit a point at 375px with a few px to spare - matches
   the standard opening position's own max stack, presumably not a
   coincidence, and confirms 5 shouldn't need a badge at all - but adding
   the badge's own height on top of a 5th checker overflows, so once a
   point does need one (6+), only 4 checkers fit alongside it. Getting
   this backwards (capping at 4 unconditionally) was a real bug caught in
   testing: it cropped the standard starting position itself, showing
   "4 + badge" on every point that opens at 5. */
const MAX_VISIBLE_PER_POINT = 5;
const MAX_VISIBLE_PER_POINT_WITH_BADGE = 4;

/* The board drawn behind the start screen. Since the opening roll became
   the players' to make, a fresh game contains no dice either, so this is
   just createInitialState() - kept as its own name because the two uses
   are genuinely different ideas that happen to coincide: one is a
   backdrop nobody is playing, the other is a game about to start, and
   `gameStarted` is what tells them apart. */
function idleState() {
  return createInitialState();
}

let state = idleState();
/* Whether a mode has actually been chosen. Distinct from `state` having
   content - the backdrop above is a perfectly valid state, so nothing
   about the state object itself says "no game yet". Every path that acts
   on the board checks this, rather than relying on the overlay to cover
   the controls. */
let gameStarted = false;
let selectedFrom = null;
let hintsEnabled = false;
/* Moves made so far this turn, oldest first, so the last one can be taken
   back. Local to this tab and deliberately not part of `state`: an undo
   stack is a UI affordance, not game data, and putting it in the state
   object would broadcast one player's deliberations to the other and drag
   it through serialization for nothing.

   Each entry keeps the state from *before* its move and a snapshot of what
   the state looked like immediately *after* it. The second is the safety
   catch: an undo is only offered while the live board still matches it, so
   a history left stale by anything else that happened - the opponent
   restarting mid-turn being the dangerous one - can never be committed and
   resurrect a dead board. If the comparison ever fails for some benign
   reason it fails safe, disabling Undo rather than doing the wrong thing. */
let turnHistory = [];
/* Which winning color the celebration overlay has already been shown for,
   distinct from state.winner itself: dismissing the overlay only hides it,
   it doesn't clear state.winner, so without this the very next render()
   (e.g. a routine online sync) would immediately show it again. Reset to
   null on restart. */
let celebrationShownFor = null;
/* Read rather than hardcoded, so the cue composes with whatever the page
   is actually called. */
const BASE_TITLE = document.title;

function pointElement(pointNumber) {
  return document.querySelector(`.point[data-point="${pointNumber}"]`);
}

function colorOf(checker) {
  return checker.classList.contains('white') ? 'white' : 'black';
}

/* Which board location a checker element currently sits in, in the terms
   rules.js uses: a point number, BAR, or null when it's already borne off. */
function locationOf(checker) {
  const parent = checker.parentElement;
  if (parent.classList.contains('bar-checkers')) {
    return BAR;
  }
  if (parent.classList.contains('off-checkers')) {
    return null;
  }
  return Number(parent.dataset.point);
}

function createChecker(color) {
  const checker = document.createElement('div');
  checker.className = `checker ${color}`;
  return checker;
}

function animateMove(checker, moveFn) {
  const before = checker.getBoundingClientRect();
  moveFn();
  const after = checker.getBoundingClientRect();
  const dx = before.left - after.left;
  const dy = before.top - after.top;

  if (dx === 0 && dy === 0) {
    return;
  }

  checker.style.transform = `translate(${dx}px, ${dy}px)`;
  requestAnimationFrame(() => {
    checker.classList.add('animating');
    checker.style.transform = '';
  });

  /* Both paths call the same idempotent cleanup, and the timeout is the
     one that matters: neither requestAnimationFrame nor transitionend
     fires in a hidden tab, which is exactly where a tab sits while waiting
     on an opponent's move online. A checker left holding its inverse
     transform would sit visibly offset from where the state says it is. */
  const settle = () => {
    checker.classList.remove('animating');
    checker.style.transform = '';
  };
  checker.addEventListener('transitionend', settle, { once: true });
  setTimeout(settle, 400);
}

/* Every container that can hold checkers, paired with what the state says
   should be in it. */
function desiredLayout() {
  const layout = new Map();

  for (let n = 1; n <= 24; n++) {
    const point = state.points[n];
    const visibleCount = point
      ? point.count > MAX_VISIBLE_PER_POINT
        ? MAX_VISIBLE_PER_POINT_WITH_BADGE
        : point.count
      : 0;
    layout.set(pointElement(n), { color: point ? point.color : null, count: visibleCount });
  }

  layout.set(barContainers.white, { color: 'white', count: Math.min(state.bar.white, MAX_VISIBLE_BAR) });
  layout.set(barContainers.black, { color: 'black', count: Math.min(state.bar.black, MAX_VISIBLE_BAR) });
  layout.set(offContainers.white, { color: 'white', count: Math.min(state.off.white, MAX_VISIBLE_OFF) });
  layout.set(offContainers.black, { color: 'black', count: Math.min(state.off.black, MAX_VISIBLE_OFF) });

  return layout;
}

/* Reconciles the existing checker elements to match the state rather than
   rebuilding the board. That matters for two reasons: the FLIP animation in
   animateMove measures the same element before and after, so a rebuild would
   silently kill it - and reusing elements means only the checkers that
   actually moved animate, whatever caused the change. A move, a hit, or (in
   future) a state update arriving from another player all take this path. */
function renderCheckers() {
  const layout = desiredLayout();
  const free = { white: [], black: [] };
  const keptCounts = new Map();

  layout.forEach((want, container) => {
    let kept = 0;
    [...container.querySelectorAll('.checker')].forEach((checker) => {
      const color = colorOf(checker);
      if (color === want.color && kept < want.count) {
        kept += 1;
      } else {
        free[color].push(checker);
      }
    });
    keptCounts.set(container, kept);
  });

  layout.forEach((want, container) => {
    for (let i = keptCounts.get(container); i < want.count; i++) {
      const checker = free[want.color].pop();
      if (checker) {
        animateMove(checker, () => container.appendChild(checker));
      } else {
        container.appendChild(createChecker(want.color));
      }
    }
  });

  /* Anything still unclaimed doesn't exist in this state, so it must leave
     the DOM. During normal play the pool always empties by itself - each
     move takes one checker off one container and puts it on another - but
     rendering an arbitrary state (a restart, or a board arriving from
     another player) can leave surplus behind, and without this the board
     would keep stale checkers that the state says are gone. */
  [...free.white, ...free.black].forEach((checker) => checker.remove());
}

/* The off tray clips rather than scrolls once its checkers stop fitting
   (see .off in style.css), so this badge is the only place the true
   count is always readable. */
function renderOffCounts() {
  offCountEls.white.textContent = state.off.white > 0 ? state.off.white : '';
  offCountEls.black.textContent = state.off.black > 0 ? state.off.black : '';
}

/* Bar counts work exactly like the off tray (see renderOffCounts above) -
   a dedicated badge element that's always present, just toggled empty.
   Points don't have one: with 24 of them, and most holding a handful of
   checkers that fit fine, a permanent badge on every point would be
   mostly-empty clutter rather than the rare exception .off-count/
   .bar-count are. So a point's badge is created only once it's actually
   needed (count > MAX_VISIBLE_PER_POINT) and removed once it isn't -
   the same reconcile-to-match-the-state approach renderCheckers takes
   with checkers themselves, just for this one extra element per point.
   Appended after renderCheckers runs, so it lands after the (already
   capped) real checkers - see MAX_VISIBLE_PER_POINT's comment for why
   that positions it correctly for both point orientations. */
function renderOverflowBadges() {
  barCountEls.white.textContent = state.bar.white > 0 ? state.bar.white : '';
  barCountEls.black.textContent = state.bar.black > 0 ? state.bar.black : '';

  for (let n = 1; n <= 24; n++) {
    const point = state.points[n];
    const element = pointElement(n);
    const existing = element.querySelector('.point-count');

    if (point && point.count > MAX_VISIBLE_PER_POINT) {
      const badge = existing || document.createElement('div');
      badge.className = `point-count ${point.color}`;
      badge.textContent = point.count;
      if (!existing) {
        element.appendChild(badge);
      }
    } else if (existing) {
      existing.remove();
    }
  }
}

function createDie(die, usable, color) {
  const element = document.createElement('div');
  element.className = `die ${color}`;
  element.dataset.value = die.value;
  if (die.played) {
    element.classList.add('played');
  } else if (!usable) {
    element.classList.add('forfeited');
  }
  for (let i = 0; i < 9; i++) {
    element.appendChild(document.createElement('span')).className = 'pip';
  }
  return element;
}

/* Which colour the Roll button would throw for right now. Online that is
   always your own seat - you roll your die, your opponent rolls theirs,
   in either order. Hot-seat has one button for two people, so it steps
   through them: White's die first, then Black's. */
function openingRollerFor() {
  if (onlineRoom) {
    return onlineColor;
  }
  if (isOpeningTie(state)) {
    return 'white';
  }
  return state.openingRoll.white === null ? 'white' : 'black';
}

function rollDisabled() {
  if (!gameStarted || Boolean(state.winner) || blockedOnline()) {
    return true;
  }
  if (state.phase === 'opening') {
    const color = openingRollerFor();
    if (!color || color === 'spectator') {
      return true;
    }
    /* Your die is already showing and the round hasn't tied, so there is
       nothing left for you to throw - you're waiting on the other player. */
    return !isOpeningTie(state) && state.openingRoll[color] !== null;
  }
  return state.dice.length > 0;
}

function renderDice() {
  diceContainer.innerHTML = '';

  if (state.phase === 'opening') {
    /* Each player's single die, in their own colour - which is what makes
       the standard procedure legible without explaining it: two dice of
       different colours, highest starts. Always white then black, so the
       pair doesn't jump around depending on who rolled first. */
    ['white', 'black'].forEach((color) => {
      const value = state.openingRoll[color];
      if (value !== null) {
        diceContainer.appendChild(createDie({ value, played: false }, true, color));
      }
    });
  } else {
    state.dice.forEach((die) => {
      diceContainer.appendChild(
        createDie(die, canUseDie(state, state.currentPlayer, die.value), state.currentPlayer)
      );
    });
  }

  rollButton.disabled = rollDisabled();
}

/* What the turn indicator says while the opening is still being decided.
   Deliberately different per audience: online each player is told about
   their own die, since "waiting for your opponent" is the thing they
   actually need; hot-seat addresses whichever player the one shared Roll
   button is about to throw for, since there is nobody else to wait on. */
function openingStatusText() {
  const { white, black } = state.openingRoll;

  if (isOpeningTie(state)) {
    return `Both rolled ${white} — roll again`;
  }

  if (onlineRoom) {
    if (onlineColor === 'spectator') {
      return 'Waiting for the opening rolls';
    }
    if (state.openingRoll[onlineColor] === null) {
      return 'Roll to see who starts';
    }
    return `You rolled ${state.openingRoll[onlineColor]} — waiting for your opponent`;
  }

  return white === null
    ? 'White, roll to see who starts'
    : `White rolled ${white} — Black, roll`;
}

/* Whether the game is currently waiting on this client to do something.
   Not the same as "it's my turn": during the opening both players may act
   at once, and what's owed is a die rather than a move. Returns the words
   for the cue, or null when nothing is owed. */
function titleCue() {
  if (!onlineRoom || onlineColor === 'spectator' || state.winner) {
    return null;
  }
  const other = onlineColor === 'white' ? 'black' : 'white';
  if (!(latestRoom && latestRoom.seats && latestRoom.seats[other])) {
    /* Nobody to play against yet, so nothing is owed - the room status
       line already says what's happening. */
    return null;
  }
  if (state.phase === 'opening') {
    return state.openingRoll[onlineColor] === null || isOpeningTie(state) ? 'Your roll' : null;
  }
  return state.currentPlayer === onlineColor ? 'Your turn' : null;
}

/* Playing online on a phone otherwise gives no sign at all that the
   opponent has moved: you switch to another app, and the only way back to
   the game is to go and look. The tab's title is the one channel a page
   still has once it isn't the thing on screen.

   Written on every render rather than only when the tab is hidden, and
   with no visibilitychange listener: a title is a status indicator, not a
   notification, so it should simply say what's true. That also removes a
   whole class of edge case - no "was it hidden when this arrived?" to get
   wrong, and it clears itself when the turn passes rather than when you
   happen to look.

   The marker leads, because a tab strip truncates from the right and the
   end of the title is the first thing to go.

   Two things this deliberately does not do. navigator.vibrate is useless
   here: the spec has it ignored outright while the document is hidden,
   which is precisely the case worth signalling. And the Notifications API
   would genuinely reach a backgrounded phone, but it needs a permission
   prompt and, on iOS, an installed PWA - a different size of feature than
   this. Worth reaching for only if the title proves too quiet.

   Its real limit, worth knowing before trusting it: a mobile browser that
   discards a backgrounded tab stops running this page altogether, so no
   title update happens either. This helps while you're briefly in another
   app, not when you come back the next day - which is what seat recovery
   (sync.js) is for. */
function renderDocumentTitle() {
  const cue = titleCue();
  document.title = cue ? `● ${cue} — ${BASE_TITLE}` : BASE_TITLE;
}

/* Whose move the indicator is about, as a colour - or null when it is
   nobody's: a finished game, a tie nobody has broken yet, a spectator.
   During the opening the answer is "whoever still owes a die", which
   online is always you, since the line speaks to you directly there. */
function turnIndicatorColor() {
  if (state.winner) {
    return null;
  }
  if (state.phase === 'opening') {
    if (isOpeningTie(state)) {
      return null;
    }
    if (onlineRoom) {
      return onlineColor === 'spectator' ? null : onlineColor;
    }
    return state.openingRoll.white === null ? 'white' : 'black';
  }
  return state.currentPlayer;
}

/* Writes the indicator as three parts rather than one string: a checker in
   the colour whose turn it is, the turn itself, and an optional aside.

   The colour is the point of it. "White's turn — opening roll: White 6,
   Black 5" is one run of same-sized bold text in which the two words that
   matter are the two easiest to skim past, and it is the *first* thing a
   new game shows - reported as hard to read at exactly that moment. A
   checker answers "whose turn?" before any of it is read, the same
   wordless cue the dice already carry, and the aside drops to a smaller,
   dimmer size so the turn leads.

   Built from nodes rather than innerHTML: nothing here is user input, but
   the rest of the file never assembles markup from strings either. */
function setTurnIndicator(text, note) {
  turnIndicator.textContent = '';
  const color = turnIndicatorColor();
  if (color) {
    const dot = document.createElement('span');
    dot.className = `turn-dot ${color}`;
    turnIndicator.appendChild(dot);
  }
  turnIndicator.appendChild(document.createTextNode(text));
  if (note) {
    /* A real space between the two, not just the aside's margin: without
       it the element's textContent reads "White's turnopening roll: …",
       which is what a screen reader announces and what a copy of the line
       contains. */
    turnIndicator.appendChild(document.createTextNode(' '));
    const aside = document.createElement('span');
    aside.className = 'turn-note';
    aside.textContent = note;
    turnIndicator.appendChild(aside);
  }
}

/* Whose turn it is, said to whoever is reading it. Online the two clients
   render the same shared state, so "White's turn" is identical on both
   screens and answers the wrong question - it says which colour is on
   turn, not whether that is you. Reported from a two-device test with the
   colour dot already in: "it says White's turn on both devices". Seated
   online it is therefore "Your turn" or "Opponent's turn"; the dot beside
   it still carries which colour that is.

   Hot-seat keeps the colour names, since two people at one screen have no
   "you" to address, and so do spectators, who are neither player. */
function turnLine() {
  if (onlineRoom && (onlineColor === 'white' || onlineColor === 'black')) {
    return state.currentPlayer === onlineColor ? 'Your turn' : "Opponent's turn";
  }
  return `${state.currentPlayer === 'white' ? 'White' : 'Black'}'s turn`;
}

/* The result, said the same way turnLine says the turn: "White wins!" is
   identical on both screens, so the loser has to know their own colour to
   read it. Hot-seat and spectators keep the colour name. */
function winnerLine() {
  if (onlineRoom && (onlineColor === 'white' || onlineColor === 'black')) {
    return state.winner === onlineColor ? 'You win!' : 'Opponent wins';
  }
  return `${state.winner === 'white' ? 'White' : 'Black'} wins!`;
}

function renderStatus() {
  const turnText = turnLine();
  if (state.winner) {
    /* It is nobody's turn any more. #game-over carries who won, so this
       says only that the game has ended - and says *something*, rather
       than emptying, because .status-row's height is part of the board's
       hand-measured budget. */
    setTurnIndicator('Game over');
  } else if (state.phase === 'opening') {
    setTurnIndicator(openingStatusText());
  } else {
    setTurnIndicator(turnText, state.openingRoll
      ? `opening roll: White ${state.openingRoll.white}, Black ${state.openingRoll.black}`
      : '');
  }
  pipCountEl.textContent = `Pips — White: ${pipCount(state, 'white')} · Black: ${pipCount(state, 'black')}`;
  gameOverEl.textContent = state.winner ? winnerLine() : '';
  renderCelebration();
}

const CONFETTI_COLORS = ['#e0a030', '#4caf50', '#6b8fa3', '#e67e22', '#c9a066', '#f0d9b5'];
const CONFETTI_PIECE_COUNT = 60;

function spawnConfetti() {
  confettiLayer.innerHTML = '';
  for (let i = 0; i < CONFETTI_PIECE_COUNT; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    piece.style.animationDuration = `${2 + Math.random() * 1.5}s`;
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    confettiLayer.appendChild(piece);
  }
}

/* Shows the overlay once per win (see celebrationShownFor above), and
   resets that guard once the game is no longer over - covering both a
   restart (state.winner goes back to null) and, in online play, a state
   arriving from another client that hasn't won. */
function renderCelebration() {
  if (!state.winner) {
    celebrationShownFor = null;
    celebrationEl.hidden = true;
    return;
  }

  if (celebrationShownFor === state.winner) {
    return;
  }
  celebrationShownFor = state.winner;

  celebrationMessageEl.textContent = winnerLine();
  spawnConfetti();
  celebrationEl.hidden = false;
}

function clearHighlights() {
  document.querySelectorAll('.legal-target').forEach((el) => el.classList.remove('legal-target'));
  document.querySelectorAll('.checker.selected').forEach((el) => el.classList.remove('selected'));
}

/* The selection is a board location, not a particular checker element -
   checkers are interchangeable, so the top one of the stack stands in for it. */
/* Which side of the board this client is sitting on. Black gets the board
   drawn from their own side - home bottom-right, moving toward it - which
   is how the game is actually played and how every other implementation
   presents it; without this, Black plays on White's board, moving
   "upward" toward a home board in the far corner.

   Presentation only. rules.js numbers points 1-24 absolutely and neither
   knows nor cares who is looking, so both players' `state` stays
   byte-identical while their screens differ - which is also what keeps a
   move meaning the same point on both sides.

   Hot-seat and spectators keep White's view: with two people at one
   screen there is no "your side" to take, and a spectator has no seat.
   Idempotent by construction, which matters because handleRoomUpdate
   calls it on every room change, not just the first. */
function setBoardPerspective(color) {
  board.classList.toggle('black-perspective', color === 'black');
}

function renderSelection() {
  clearHighlights();
  if (selectedFrom === null) {
    return;
  }

  const container = selectedFrom === BAR ? barContainers[state.currentPlayer] : pointElement(selectedFrom);
  const checkers = container.querySelectorAll('.checker');
  if (checkers.length > 0) {
    checkers[checkers.length - 1].classList.add('selected');
  }

  if (!hintsEnabled) {
    return;
  }

  getLegalDestinations(state, state.currentPlayer, selectedFrom).forEach((destination) => {
    const element =
      destination === OFF
        ? document.querySelector(`.off[data-owner="${state.currentPlayer}"]`)
        : pointElement(destination);
    element.classList.add('legal-target');
  });
}

function render() {
  /* Any state change disarms. The confirmation was armed over a particular
     board, and if that board has moved on - the opponent played, or
     restarted themselves - the second tap would be answering a question
     nobody asked any more. Fails toward not restarting. */
  disarmRestart();
  pruneUndoHistory();
  undoButton.disabled = !canUndo();
  renderDocumentTitle();
  renderCheckers();
  renderOffCounts();
  renderOverflowBadges();
  renderDice();
  renderStatus();
  renderSelection();
}

function flashInvalid(element) {
  element.classList.add('invalid-target');
  setTimeout(() => element.classList.remove('invalid-target'), 300);
}

/* `sticky` messages stay until the player does something, rather than
   expiring on a timer. That matters for the skipped-turn notice: the dice
   explaining *why* a turn was skipped are cleared by the skip itself, so a
   three-second window removed the only surviving record of the reason at
   the same moment as the evidence. */
function showMessage(text, { sticky } = {}) {
  messageEl.textContent = text;
  if (sticky) {
    return;
  }
  setTimeout(() => {
    if (messageEl.textContent === text) {
      messageEl.textContent = '';
    }
  }, 3000);
}

function clearMessage() {
  messageEl.textContent = '';
}

/* A die is only given up once no checker can use it, and the turn only ends
   once every remaining die is unusable - so a die that looks dead can come
   back to life after a move changes the board. Re-evaluated after every
   move rather than forfeited once and for all.

   Returns the state to actually commit, rather than mutating global state
   itself - it needs to run exactly once, on whichever client just made the
   move, before that result is broadcast. Running it again on a state that
   already went through it (as a receiving client would see) would flip the
   turn a second time, since by then the dice are already empty. */
function resolveTurn(next) {
  if (availableDice(next).length === 0) {
    return endTurn(next);
  }

  if (!hasAnyLegalMove(next, next.currentPlayer)) {
    const values = availableDice(next).map((die) => die.value).join(', ');
    showMessage(`No legal move for ${values} — skipped.`, { sticky: true });
    return endTurn(next);
  }

  return next;
}

/* Records a move as undoable, unless it was the move that ended the turn.
   Once the turn has passed there is nothing to take back: online the
   opponent may already be acting on it, and even in hot-seat "undo" would
   mean un-ending a turn rather than un-making a move. Picking the dice up
   ends the turn in the real game too. */
function recordUndoPoint(before, after) {
  if (after.currentPlayer !== before.currentPlayer || after.winner) {
    turnHistory = [];
    return;
  }
  turnHistory.push({ player: before.currentPlayer, before, afterJSON: canonicalJson(after) });
}

/* Drops a history belonging to a turn that is no longer the current one -
   whoever ended it, and whether this client or the opponent caused the
   change. Called from render(), so every path that can change the state
   passes through it. */
function pruneUndoHistory() {
  if (turnHistory.length > 0 && turnHistory[0].player !== state.currentPlayer) {
    turnHistory = [];
  }
}

function canUndo() {
  if (!gameStarted || state.winner || state.phase !== 'playing' || blockedOnline()) {
    return false;
  }
  const last = turnHistory[turnHistory.length - 1];
  return Boolean(last) && canonicalJson(state) === last.afterJSON;
}

/* Online this broadcasts like any other change, so the opponent watches the
   checker go back - which is what taking a move back looks like across a
   real board, and is the honest behaviour given every move is already
   broadcast as it is made. */
function undoLastMove() {
  if (!canUndo()) {
    return;
  }
  const { before } = turnHistory.pop();
  selectedFrom = null;
  messageEl.textContent = '';
  commitState(before);
}

undoButton.addEventListener('click', undoLastMove);

function attemptMove(from, to, targetElement) {
  /* Clears a sticky skipped-turn notice from the previous turn: it stays
     until the player acts, and this is them acting. */
  clearMessage();
  const result = applyMove(state, state.currentPlayer, from, to);

  if (!result.ok) {
    flashInvalid(targetElement);
    return;
  }

  selectedFrom = null;
  if (result.hit) {
    showMessage('Hit — their checker goes to the bar.');
  }
  /* resolveTurn may replace that with a skipped-turn notice, which is the
     more actionable of the two. */
  const next = result.state.winner ? result.state : resolveTurn(result.state);
  recordUndoPoint(state, next);
  commitState(next);
}

function canSelect(from) {
  return selectionProblem(state, state.currentPlayer, from) === null;
}

/* rules.js says which rule refused the click; this says it in words. The
   turn case reads differently online, where "your opponent's" is more use
   than a colour name. */
function selectionMessage(problem) {
  if (problem === SELECT_NOT_YOUR_TURN) {
    return onlineRoom
      ? "Those are your opponent's checkers."
      : `It's ${state.currentPlayer === 'white' ? 'White' : 'Black'}'s turn.`;
  }
  if (problem === SELECT_NO_DICE) {
    return 'Roll the dice first.';
  }
  if (problem === SELECT_BAR_FIRST) {
    return 'You must bring your checker in from the bar first.';
  }
  return 'That checker has nowhere to go.';
}

/* Why the board is not accepting input at all, as opposed to why one
   particular checker cannot be picked up. */
function onlineRefusalMessage() {
  if (onlineColor === 'spectator') {
    return 'You are watching this game.';
  }
  const other = onlineColor === 'white' ? 'black' : 'white';
  if (!(latestRoom && latestRoom.seats && latestRoom.seats[other])) {
    return 'Waiting for an opponent to join.';
  }
  return "It's your opponent's turn.";
}

board.addEventListener('click', (event) => {
  const checker = event.target.closest('.checker');
  const point = event.target.closest('.point');
  const offTray = event.target.closest('.off');

  if (!gameStarted || state.winner) {
    return;
  }

  /* Only explain a refusal when the click actually landed on something.
     Tapping the wood between points is exploratory, and answering it would
     turn the message line into noise. */
  if (blockedOnline()) {
    if (checker || point) {
      showMessage(onlineRefusalMessage());
    }
    return;
  }

  if (selectedFrom !== null && offTray && offTray.dataset.owner === state.currentPlayer) {
    attemptMove(selectedFrom, OFF, offTray);
    return;
  }

  /* A click on a different own-color checker is ambiguous with a move
     attempt onto its point (both match `.point`/`.checker` at once). Only
     treat it as a move if that point is actually a legal destination for
     the selected checker (e.g. stacking onto it) - otherwise the click
     means "select this checker instead", not "attempt an illegal move". */
  if (
    selectedFrom !== null &&
    checker &&
    colorOf(checker) === state.currentPlayer &&
    locationOf(checker) !== selectedFrom &&
    !getLegalDestinations(state, state.currentPlayer, selectedFrom).includes(locationOf(checker))
  ) {
    const from = locationOf(checker);
    const problem = selectionProblem(state, state.currentPlayer, from);
    if (problem) {
      showMessage(selectionMessage(problem));
    } else {
      selectedFrom = from;
      renderSelection();
    }
    return;
  }

  if (selectedFrom !== null && point && Number(point.dataset.point) !== selectedFrom) {
    attemptMove(selectedFrom, Number(point.dataset.point), point);
    return;
  }

  if (checker) {
    const from = locationOf(checker);
    /* Already borne off - there is nothing to say about a checker that has
       finished. */
    if (from === null) {
      return;
    }
    if (from === selectedFrom) {
      selectedFrom = null;
      renderSelection();
      return;
    }
    const problem = selectionProblem(state, colorOf(checker), from);
    if (problem) {
      showMessage(selectionMessage(problem));
      return;
    }
    selectedFrom = from;
    renderSelection();
    return;
  }

  selectedFrom = null;
  renderSelection();
});

rollButton.addEventListener('click', () => {
  if (!gameStarted || state.winner || blockedOnline()) {
    return;
  }
  clearMessage();

  if (state.phase === 'opening') {
    const color = openingRollerFor();
    if (!color || color === 'spectator') {
      return;
    }
    const next = rollOpeningDie(state, color);
    /* rollOpeningDie returns the same object when there was nothing to
       roll - a double tap, or a click that raced a broadcast. Committing
       it anyway would be a harmless no-op, but it would still cost a
       round trip and a render for nothing. */
    if (next === state) {
      return;
    }
    selectedFrom = null;
    /* resolveTurn only applies once the opening actually resolved and
       real dice exist. It runs on this client, the one that made the
       change, exactly as it does for an ordinary roll. */
    commitState(next.phase === 'playing' ? resolveTurn(next) : next);
    return;
  }

  if (state.dice.length > 0) {
    return;
  }
  selectedFrom = null;
  commitState(resolveTurn(withRoll(state, rollValues())));
});

function restartGame() {
  if (onlineRoom && onlineColor === 'spectator') {
    return;
  }
  if (onlineRoom && !bothSeatsClaimed(latestRoom)) {
    return;
  }
  selectedFrom = null;
  turnHistory = [];
  messageEl.textContent = '';
  commitState(createInitialState());
}

/* Restart wipes a game in progress for *both* players, either of them can
   press it at any time, and it is not recoverable the way Exit is - the
   start screen can offer a room back, but not a board. On a phone it sat
   one mis-tap away from destroying a live game, and putting Exit beside it
   made that likelier rather than less.

   So a mid-game Restart arms first and acts on the second press. Two
   deliberate taps in the same place is a real guard against the actual
   threat, which is a mis-tap, and it costs nothing when the press was
   meant. A native confirm() would be blunter and a modal would be more
   code; neither buys anything against a slipped thumb.

   Only when there is something to lose: a finished game or one still
   deciding who starts restarts on the first press, because "are you sure
   you want to play again?" is a question nobody needs asked. */
const RESTART_ARM_MS = 4000;
let restartArmed = false;
let restartArmTimer = null;

function restartNeedsConfirming() {
  return state.phase === 'playing' && !state.winner;
}

function renderRestartLabel() {
  restartButton.textContent = restartArmed ? 'Restart?' : 'Restart';
  restartButton.classList.toggle('armed', restartArmed);
}

function disarmRestart() {
  if (!restartArmed) {
    return;
  }
  restartArmed = false;
  clearTimeout(restartArmTimer);
  restartArmTimer = null;
  renderRestartLabel();
}

function armRestart() {
  restartArmed = true;
  renderRestartLabel();
  showMessage('Tap Restart again to start a new game.');
  clearTimeout(restartArmTimer);
  restartArmTimer = setTimeout(disarmRestart, RESTART_ARM_MS);
}

restartButton.addEventListener('click', () => {
  if (!restartNeedsConfirming()) {
    restartGame();
    return;
  }
  if (restartArmed) {
    disarmRestart();
    restartGame();
    return;
  }
  armRestart();
});

/* Play Again lives on the win overlay, where a new game is the entire
   point of the button - there is nothing left to protect. */
playAgainButton.addEventListener('click', restartGame);

/* Dismiss on any click on the backdrop, but not one that started inside
   the card itself - stopping propagation there rather than checking
   event.target here, so a click on the card's padding (not the button)
   doesn't dismiss either. */
celebrationEl.addEventListener('click', () => {
  celebrationEl.hidden = true;
});
document.querySelector('#celebration-content').addEventListener('click', (event) => {
  event.stopPropagation();
});

hintsToggle.addEventListener('change', () => {
  hintsEnabled = hintsToggle.checked;
  pipCountEl.hidden = !hintsEnabled;
  renderSelection();
});

/* ---- The rotate hint ----------------------------------------------------
 * Advice, not news. It's worth saying once to someone meeting a 24-point
 * board on a portrait phone, and pure clutter for the rest of the game to
 * someone who has read it and decided to stay in portrait - which is a
 * decision, not something to be nagged about every turn. So it dismisses
 * on a tap, and the dismissal is remembered across visits: a returning
 * player has already answered the question.
 *
 * Remembered in localStorage rather than sessionStorage on purpose. The
 * preference is about this player's phone, not this tab, and a mobile
 * browser discarding a backgrounded tab (the same behaviour seat recovery
 * in sync.js exists for) would otherwise bring the hint back mid-game.
 *
 * Guarded like sync.js's lastRoomCode and for the same reason: this runs
 * on every page load, and Safari's private mode has historically thrown on
 * storage access. Losing the memory of a dismissal is an acceptable
 * failure; taking the app down for someone who only wanted to play is not.
 */
const ROTATE_HINT_KEY = 'backgammon:rotate-hint-dismissed';

function rotateHintDismissed() {
  try {
    return localStorage.getItem(ROTATE_HINT_KEY) === 'true';
  } catch (error) {
    return false;
  }
}

function dismissRotateHint() {
  rotateHintEl.hidden = true;
  try {
    localStorage.setItem(ROTATE_HINT_KEY, 'true');
  } catch (error) {
    /* it stays dismissed for this visit; it just comes back on the next */
  }
}

rotateHintEl.hidden = rotateHintDismissed();
rotateHintEl.addEventListener('click', dismissRotateHint);

/* ---- Start screen -------------------------------------------------------
 * The one place a mode is chosen, and the only thing that sets
 * gameStarted. Both exits from here create the game rather than reveal a
 * game that was already sitting there: hot-seat calls createInitialState()
 * at the moment of the click, and online leaves the seeding to whichever
 * client gets there first (handleRoomUpdate), once both seats are filled.
 */

/* Withdraws this client's advertisement. Called when an opponent arrives -
   from the queue or from an invite link, which are indistinguishable by
   the time the second seat is claimed - and when the player leaves. Safe
   to call when there is nothing to withdraw. */
function stopSearching() {
  if (lobbyAdvertisement) {
    lobbyAdvertisement.stop();
    lobbyAdvertisement = null;
  }
}

function leaveStartScreen() {
  startScreenEl.hidden = true;
  gameStarted = true;
}

/* The way back. Tears down whatever kind of game was running and returns
   to the screen in the state a fresh visit would find it - so leaving and
   starting again is genuinely a new game, not the old one with the
   overlay put back over it.

   For an online game it also announces the departure (sync.js's
   leave({departed}), which the opponent's status line reads) rather than
   just going quiet. The seat itself is deliberately *not* freed: seats
   are never released in this design, and 5a's recovery depends on that -
   coming back to the same room reclaims the same seat rather than finding
   a stranger in it.

   The room code comes off the URL with replaceState rather than by
   assigning location.hash, which would leave a bare "#" behind and push a
   history entry for a screen the player is already looking at. */
function exitToStartScreen() {
  if (onlineRoom) {
    /* Asked before leaving, because leave() is what empties the room and
       the answer stops being available the moment it has. Same predicate
       sync.js uses to decide the deletion, so the offer and the record
       cannot disagree - the alternative, waiting for the transaction to
       report back, would have renderStartScreen below run first and
       briefly offer a room that was already going. */
    if (roomIsSpent(latestRoom, onlineColor)) {
      forgetRoom(currentRoomCode);
    }
    onlineRoom.leave({ departed: true });
    onlineRoom = null;
    onlineColor = null;
    latestRoom = null;
    currentRoomCode = null;
    qrRenderedForRoom = null;
    acceptedStates = [];
    rejectedStates = [];
    roomStatusEl.hidden = true;
    qrPanelEl.hidden = true;
    document.body.classList.remove('showing-room-row');
  }
  stopSearching();

  /* Back to White's view - whatever comes next (a hot-seat game, or a room
     where this client is White) is drawn that way until a seat says
     otherwise. Outside the online branch above deliberately: this function
     restores the screen to what a fresh visit would find, and that should
     not depend on how the board came to be flipped. */
  setBoardPerspective(null);

  history.replaceState(null, '', location.pathname + location.search);

  gameStarted = false;
  state = idleState();
  selectedFrom = null;
  turnHistory = [];
  disarmRestart();
  celebrationShownFor = null;
  celebrationEl.hidden = true;
  messageEl.textContent = '';
  /* Both of these are disabled by renderRoomStatus while online and
     nothing else re-enables them - a hot-seat game started after an exit
     would otherwise find Restart dead. */
  restartButton.disabled = false;
  playAgainButton.disabled = false;
  startErrorEl.hidden = true;
  roomCodeInput.value = '';
  renderStartScreen();
  startScreenEl.hidden = false;
  render();
}

exitButton.addEventListener('click', exitToStartScreen);

/* Whether to offer the last room back. Recomputed each time the screen is
   shown rather than once at load, so the code just left behind by Exit is
   the one offered - a mis-tapped Exit is one tap from being undone. */
function renderStartScreen() {
  rejoinButton.hidden = !lastRoomCode();
}

rejoinButton.addEventListener('click', () => {
  const code = lastRoomCode();
  if (code) {
    location.hash = `room=${code}`;
    startOnline(code);
  }
});

function showStartError(text) {
  startErrorEl.textContent = text;
  startErrorEl.hidden = false;
}

startHotseatButton.addEventListener('click', () => {
  leaveStartScreen();
  commitState(createInitialState());
});

/* ---- Online play (Stage C) --------------------------------------------
 * See sync.js for the room/transport model. In hot-seat mode (no room
 * joined) commitState is the only thing this section touches, and it just
 * falls through to a plain local assignment - so offline play makes zero
 * localStorage or BroadcastChannel calls, deliberately: a game with no
 * room code in the URL should behave exactly as it did before any of this
 * existed.
 */

let onlineRoom = null;
let onlineColor = null;
let currentRoomCode = null;
/* Most recent room object seen from handleRoomUpdate - kept around so
   blockedOnline() can check opponent seat occupancy without waiting for a
   render pass. */
let latestRoom = null;
/* Which room the QR panel currently holds a rendered code for - regenerate
   only when that stops matching currentRoomCode, rather than on every
   toggle-open. */
let qrRenderedForRoom = null;
/* This client's lobby advertisement while it waits to be claimed, cleared
   the moment an opponent arrives, by whichever route. There used to be a
   live count of other searchers beside it, feeding "2 others searching"
   into the waiting line; the line says only "Waiting for an opponent…"
   now, so the subscription that fed it is gone rather than left running
   for nobody. sync.js's watchLobbyCount stays - the test suite observes
   the queue through it, and it is one call away if the count returns. */
let lobbyAdvertisement = null;
/* Set while joining a room the lobby handed us, so that landing as a
   spectator can be recognised as a stale advertisement rather than a
   deliberate spectate - see handleRoomUpdate. */
let joinedFromLobby = false;
/* Recently accepted states, as JSON, newest last. Two jobs: recognising
   Firebase echoing this client's own writes back, and recognising an undo,
   which reverts to a state broadcast moments ago and is far easier to
   identify by memory than by reasoning backwards through a move. Eight
   covers a doubles turn with slack. */
const ACCEPTED_HISTORY = 8;
let acceptedStates = [];
/* Distinct states refused since the last accepted one. What the number
   means, and why it counts distinct states rather than attempts, belongs
   with the policy - see judgeArrivingState and REJECTIONS_BEFORE_RESYNC in
   rules.js. This is only where the list is kept. */
let rejectedStates = [];

/* The gate for "is this tab allowed to act right now": a spectator never
   is; neither is a seated player before the other seat has ever been
   claimed (nothing to roll against yet - see the "waiting for opponent"
   status line); otherwise it comes down to whether it's this seat's turn.
   Deliberately keyed on seat occupancy (room.seats), not live presence
   (room.presence) - seats are never freed once claimed, so a later
   disconnect shouldn't re-block a game that already started, only the
   status line should mention it. */
function blockedOnline() {
  if (!onlineRoom) {
    return false;
  }
  if (onlineColor === 'spectator') {
    return true;
  }
  const other = onlineColor === 'white' ? 'black' : 'white';
  if (!(latestRoom && latestRoom.seats && latestRoom.seats[other])) {
    return true;
  }
  /* Nobody is on turn while the opening is being decided - both players
     roll, in either order - so the turn check can't apply yet. What stops
     you rolling twice is rollDisabled, not this. */
  if (state.phase === 'opening') {
    return false;
  }
  return onlineColor !== state.currentPlayer;
}

/* Both seats claimed - i.e. an opponent has shown up at least once (seats
   are never freed, so this doesn't require them to still be connected; see
   the presence discussion above). Gates the initial seed in
   handleRoomUpdate and Restart.

   The original reason was anti-abuse: createInitialState used to roll the
   opening itself, so the room's creator, alone, could Restart repeatedly
   until a roll favoured them and only then let anyone see it. That reason
   is gone - a fresh game now contains no roll at all, and each player
   throws their own die. The gate stays for the plainer one: there is no
   game to seed or reset until somebody is there to play it. */
function bothSeatsClaimed(room) {
  return Boolean(room && room.seats && room.seats.white && room.seats.black);
}

/* Every local change to `state` goes through here rather than assigning the
   variable directly, so hot-seat and online play are the same call site
   with one branch: apply it locally, or hand it to sync.js to broadcast
   (which loops back to this tab too, via handleRoomUpdate). */
function commitState(newState) {
  /* Cleared here rather than left to each caller. handleRoomUpdate already
     did this for arriving states while the hot-seat branch did not, so the
     two paths disagreed about whose job it was - harmless while every
     caller happened to clear it themselves, and an easy trap for the next
     one that does not. */
  selectedFrom = null;
  if (onlineRoom) {
    onlineRoom.sendState(newState);
  } else {
    state = newState;
    render();
  }
}

/* Seats never empty once claimed (see sync.js's claimSeat) - a reload is
   meant to reclaim the same seat, not free it - so seat occupancy alone
   can't tell "opponent hasn't shown up yet" apart from "opponent was here
   and left". room.presence (also sync.js) can: it's only set while the
   other tab is actually connected, cleared automatically by Firebase the
   moment it disconnects. Distinguishing the two states is what a
   returning player actually wants to know before they keep waiting on a
   move that isn't coming. */
function renderRoomStatus(room) {
  if (!onlineColor) {
    return;
  }
  const other = onlineColor === 'white' ? 'black' : 'white';
  const seatTaken = onlineColor !== 'spectator' && Boolean(room.seats[other]);
  const otherPresent = seatTaken && Boolean(room.presence && room.presence[other]);
  /* Set only by the opponent pressing Exit (sync.js's leave({departed})),
     never by a connection simply dropping - which is the difference
     between "they quit" and "they might be back in a second". */
  const otherDeparted = seatTaken && Boolean(room.departed && room.departed[other]);
  const you = `You are ${onlineColor === 'white' ? 'White' : 'Black'}`;

  /* One line, built whole rather than as a prefix plus a suffix, because
     the waiting case now replaces the prefix rather than adding to it.

     No room code in any of them, on purpose. It is the one piece of this
     line that nobody who came in through Find an opponent ever needs: it
     is in the address bar, and both ways of handing it to somebody (Copy
     link, QR) carry it without anyone having to read it off the screen.
     What is left is only what the player can act on. */
  let line = '';
  if (onlineColor === 'spectator') {
    line = 'Spectating';
  } else if (!seatTaken) {
    /* The whole line, not "You are White — waiting…": before an opponent
       exists your colour decides nothing, and the count of other
       searchers ("nobody else is searching", "2 others searching") was a
       fact about the queue rather than something the player could act
       on. Copy link and QR sit right beside this, which is the one thing
       an empty queue actually calls for. */
    line = 'Waiting for an opponent…';
  } else if (otherDeparted) {
    /* Checked before presence: leaving clears presence too, so an
       opponent who quit satisfies both conditions and the more specific
       one has to win. */
    line = `${you} — opponent left the game`;
  } else if (!otherPresent) {
    line = `${you} — opponent disconnected`;
  }
  roomInfoEl.textContent = line;
  roomStatusEl.classList.toggle('room-status--warning', otherDeparted || (seatTaken && !otherPresent));

  /* The row earns its space only while it has something to say. During an
     ordinary game it does not - the room code is in the address bar if
     anyone wants it, and Copy link matters while you are waiting for
     somebody, not while you are playing them. So it goes away and the
     board grows into the space (see --reclaimed in style.css), and comes
     back by itself the moment there is news: an opponent who has not
     arrived, disconnected, or left. A spectator always sees it, since
     otherwise nothing on screen would say they cannot play - which falls
     out of the line above being non-empty for them. */
  const worthARow = line !== '';
  roomStatusEl.hidden = !worthARow;
  roomDetailsEl.hidden = false;
  document.body.classList.toggle('showing-room-row', worthARow);

  /* An opponent has arrived, so the room must come off the list before
     anyone else is sent to it. Whether they came from the queue or from an
     invite link is not knowable here, and does not matter. */
  if (bothSeatsClaimed(room)) {
    stopSearching();
  }

  const restartBlocked = onlineColor === 'spectator' || !bothSeatsClaimed(room);
  restartButton.disabled = restartBlocked;
  playAgainButton.disabled = restartBlocked;
}

/* Fires once on join with whatever is already in the room (possibly empty),
   and again every time it changes - whether this client changed it or
   another one did. If the room has no state yet and both seats are now
   claimed, White seeds the starting position (including the opening roll)
   and broadcasts it.

   Seeding waits for both seats (see bothSeatsClaimed above). It used to
   be an anti-abuse measure, since the seeded state carried a ready-made
   opening roll; now that the roll belongs to the players there is nothing
   to game, and the gate simply avoids putting a board in a room nobody
   has arrived at yet.

   `== null` rather than `=== null`: Firebase never actually stores a null
   value - a key written as null is simply absent from what a listener
   receives back, so a freshly-created room's `state` arrives as undefined,
   not null. `== null` matches both. */
function handleRoomUpdate(room, color) {
  /* The lobby sent us to a room that had filled up in the meantime - its
     advertisement was stale. Landing as a spectator here is not a choice
     the player made, so back out and start a room of our own instead of
     stranding them watching strangers. Entries are withdrawn when a room
     fills and on disconnect, so this is rare rather than routine. */
  if (joinedFromLobby && color === 'spectator') {
    joinedFromLobby = false;
    exitToStartScreen();
    showStartError('That game had just filled up — try again.');
    return;
  }
  joinedFromLobby = false;

  onlineColor = color;
  latestRoom = room;
  setBoardPerspective(color);
  renderRoomStatus(room);

  /* One render, unconditionally, whatever adoptRoomState decided. That is
     structural rather than tidy: the previous version returned early on
     each refusal and on a room with no state yet, and every one of those
     paths left the screen showing the render from *before* this client
     went online - the backdrop's "White, roll to see who starts" over a
     game that had moved on, with Roll disabled from when no game had
     started. It read as a dead app. A single exit cannot forget. */
  const notice = adoptRoomState(room);
  render();
  if (notice) {
    showMessage(notice);
  }
}

/* Decides nothing itself - judgeArrivingState in rules.js does that, where
   it can be tested - and does only what a decision cannot: seeds an empty
   room, swaps in the state, keeps the memory the judgement runs on, and
   returns whatever the player should be told, or null.

   `== null` rather than `=== null`: Firebase never actually stores a null
   value - a key written as null is simply absent from what a listener
   receives back, so a freshly-created room's `state` arrives as undefined,
   not null. `== null` matches both.

   Seeding waits for both seats (see bothSeatsClaimed above). It used to be
   an anti-abuse measure, since the seeded state carried a ready-made
   opening roll; now that the roll belongs to the players there is nothing
   to game, and the gate simply avoids putting a board in a room nobody has
   arrived at yet. */
function adoptRoomState(room) {
  if (room.state == null) {
    if (onlineColor === 'white' && bothSeatsClaimed(room)) {
      onlineRoom.sendState(createInitialState());
    }
    return null;
  }

  const decision = judgeArrivingState(state, room.state, {
    accepted: acceptedStates,
    rejected: rejectedStates,
  });
  rejectedStates = decision.rejected;

  if (decision.verdict === ARRIVAL_REFUSE) {
    return refusalNotice(decision.reason);
  }

  /* Worked out by comparison rather than announced, because nothing in the
     broadcast says a hit happened - the board simply changes underneath
     the player it happened to, which online is no cue at all. Read before
     `state` is replaced, since it is the difference that carries it. */
  const hitMe =
    onlineColor && onlineColor !== 'spectator' && wasHit(state, room.state, onlineColor);

  state = room.state;
  acceptedStates.push(canonicalJson(state));
  if (acceptedStates.length > ACCEPTED_HISTORY) {
    acceptedStates.shift();
  }
  selectedFrom = null;

  /* Resynchronising wins over the hit notice when both apply, which is a
     change from the version that showed the hit. Across a resync the two
     states being compared are several moves apart, so "you were hit" is a
     guess about which turn it happened on; that the board jumped is the
     thing actually worth saying. */
  if (decision.verdict === ARRIVAL_RESYNC) {
    return 'Resynchronised with your opponent.';
  }
  if (hitMe) {
    return 'Your checker was hit — you must bring it in from the bar.';
  }
  return null;
}

/* The sentence for a refusal code, the same split selectionMessage above
   uses: rules.js says which bar was hit, script.js says it in English. */
function refusalNotice(reason) {
  if (reason === ARRIVAL_IMPOSSIBLE_BOARD) {
    return 'Ignored an impossible board from your opponent.';
  }
  if (reason === ARRIVAL_UNEXPLAINED_WIN) {
    return 'Ignored an unexplained win from your opponent.';
  }
  return 'Ignored an impossible move from your opponent.';
}

function startOnline(roomCode) {
  currentRoomCode = roomCode;
  rememberRoom(roomCode);
  leaveStartScreen();
  /* Cleared here rather than only in exitToStartScreen, so that "nothing
     has arrived from this room yet" is a fact about joining a room rather
     than a promise every caller has to have kept. handleRoomUpdate reads
     an empty acceptedStates as "no predecessor to judge the first state
     against", which is only true if entering a room always resets it. */
  acceptedStates = [];
  rejectedStates = [];
  roomStatusEl.hidden = false;
  onlineRoom = joinRoom(roomCode, { onRoom: handleRoomUpdate });
}

/* Two people who both pressed this used to land in two different empty
   rooms and wait for each other forever, the codes being random. Now it
   asks the lobby first: join whoever is already waiting, or start a room
   and wait to be joined - by a searcher or by a friend you send the link
   to, whichever arrives first. */
playOnlineButton.addEventListener('click', () => {
  playOnlineButton.disabled = true;
  findOrStartRoom({ clientId: lobbyClientId() })
    .then(({ roomCode, advertisement }) => {
      lobbyAdvertisement = advertisement;
      joinedFromLobby = advertisement === null;
      location.hash = `room=${roomCode}`;
      startOnline(roomCode);
    })
    .catch(() => {
      /* The lobby is unreachable - most likely its rules have not been
         deployed. Falling back to a plain room keeps the button working as
         it always did, rather than leaving the player with a dead press. */
      const roomCode = randomRoomCode();
      location.hash = `room=${roomCode}`;
      startOnline(roomCode);
    })
    .then(() => {
      playOnlineButton.disabled = false;
    });
});

/* Beyond pasting a full invite link (still fully supported - see the
   roomFromUrl bootstrap below), a room code alone is meant to be typeable:
   sync.js's alphabet was chosen to be easy to read aloud or type into a
   second device. This is that path's UI. */
function joinWithCode() {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    /* Not showMessage: that writes into #message down in the dice area,
       which the start screen covers - the join controls only exist on
       that screen, so the only place feedback can actually be read is
       inside the panel itself. */
    showStartError('Enter a 6-character room code.');
    return;
  }
  location.hash = `room=${code}`;
  startOnline(code);
}

/* Folded away until someone says they have a code, so the common path
   isn't asked to read past it. */
document.querySelector('#start-code-toggle').addEventListener('click', () => {
  const joinArea = document.querySelector('#join-area');
  joinArea.hidden = !joinArea.hidden;
  if (!joinArea.hidden) {
    roomCodeInput.focus();
  }
});

joinRoomButton.addEventListener('click', joinWithCode);
roomCodeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    joinWithCode();
  }
});
/* Clear a rejection as soon as they start fixing it, rather than leaving
   stale red text sitting under a code they've already corrected. */
roomCodeInput.addEventListener('input', () => {
  startErrorEl.hidden = true;
});

copyLinkButton.addEventListener('click', () => {
  navigator.clipboard.writeText(location.href).then(() => showMessage('Link copied.'));
});

/* Renders lazily (first open, or a room change) rather than on every room
   update, since the QR encoding itself doesn't depend on anything but the
   URL, which only changes when currentRoomCode does. */
qrToggleButton.addEventListener('click', () => {
  qrPanelEl.hidden = !qrPanelEl.hidden;
  if (!qrPanelEl.hidden && qrRenderedForRoom !== currentRoomCode) {
    const qr = qrcode(0, 'M');
    qr.addData(location.href);
    qr.make();
    qrCodeEl.innerHTML = qr.createSvgTag(4, 8);
    qrRenderedForRoom = currentRoomCode;
  }
});

/* Pasting a full invite link (e.g. .../index.html#room=ABCDEF) straight
   into the address bar still works exactly as before - join-by-code and
   the QR code above are additional ways in, not replacements for this. */
renderStartScreen();

const roomFromUrl = location.hash.match(/room=([A-Z0-9]{6})/i);
if (roomFromUrl) {
  startOnline(roomFromUrl[1].toUpperCase());
}

render();
