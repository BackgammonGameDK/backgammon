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
const restartButton = document.querySelector('#restart-button');
const exitButton = document.querySelector('#exit-button');
const gameOverEl = document.querySelector('#game-over');
const turnIndicator = document.querySelector('#turn-indicator');
const messageEl = document.querySelector('#message');
const hintsToggle = document.querySelector('#hints-toggle');
const pipCountEl = document.querySelector('#pip-count');
const playOnlineButton = document.querySelector('#play-online-button');
const startScreenEl = document.querySelector('#start-screen');
const startHotseatButton = document.querySelector('#start-hotseat-button');
const startErrorEl = document.querySelector('#start-error');
const rejoinButton = document.querySelector('#rejoin-button');
const rejoinCodeEl = document.querySelector('#rejoin-code');
const roomCodeInput = document.querySelector('#room-code-input');
const joinRoomButton = document.querySelector('#join-room-button');
const roomStatusEl = document.querySelector('#room-status');
const roomChipEl = document.querySelector('#room-chip');
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
/* Whether the room-code chip's popover (#room-details) has been opened
   while collapsed - see renderRoomStatus. Irrelevant, and ignored, while
   the row isn't collapsed at all. */
let roomDetailsOpen = false;
/* Which winning color the celebration overlay has already been shown for,
   distinct from state.winner itself: dismissing the overlay only hides it,
   it doesn't clear state.winner, so without this the very next render()
   (e.g. a routine online sync) would immediately show it again. Reset to
   null on restart. */
let celebrationShownFor = null;

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

  checker.addEventListener(
    'transitionend',
    () => {
      checker.classList.remove('animating');
      checker.style.transform = '';
    },
    { once: true }
  );
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

function renderStatus() {
  const turnText = `${state.currentPlayer === 'white' ? 'White' : 'Black'}'s turn`;
  if (state.phase === 'opening') {
    turnIndicator.textContent = openingStatusText();
  } else {
    turnIndicator.textContent = state.openingRoll
      ? `${turnText} — opening roll: White ${state.openingRoll.white}, Black ${state.openingRoll.black}`
      : turnText;
  }
  pipCountEl.textContent = `Pips — White: ${pipCount(state, 'white')} · Black: ${pipCount(state, 'black')}`;
  gameOverEl.textContent = state.winner ? `${state.winner === 'white' ? 'White' : 'Black'} wins!` : '';
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

  celebrationMessageEl.textContent = `${state.winner === 'white' ? 'White' : 'Black'} wins!`;
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

function showMessage(text) {
  messageEl.textContent = text;
  setTimeout(() => {
    if (messageEl.textContent === text) {
      messageEl.textContent = '';
    }
  }, 3000);
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
    showMessage(`No legal move for ${values} — skipped.`);
    return endTurn(next);
  }

  return next;
}

function attemptMove(from, to, targetElement) {
  const result = applyMove(state, state.currentPlayer, from, to);

  if (!result.ok) {
    flashInvalid(targetElement);
    return;
  }

  selectedFrom = null;
  commitState(result.state.winner ? result.state : resolveTurn(result.state));
}

function canSelect(from) {
  return (
    availableDice(state).length > 0 &&
    getLegalDestinations(state, state.currentPlayer, from).length > 0
  );
}

board.addEventListener('click', (event) => {
  if (!gameStarted || state.winner || blockedOnline()) {
    return;
  }

  const checker = event.target.closest('.checker');
  const point = event.target.closest('.point');
  const offTray = event.target.closest('.off');

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
    if (canSelect(from)) {
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
    if (from === null || colorOf(checker) !== state.currentPlayer) {
      return;
    }
    if (from === selectedFrom) {
      selectedFrom = null;
    } else if (canSelect(from)) {
      selectedFrom = from;
    }
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
  messageEl.textContent = '';
  commitState(createInitialState());
}

restartButton.addEventListener('click', restartGame);
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

/* ---- Start screen -------------------------------------------------------
 * The one place a mode is chosen, and the only thing that sets
 * gameStarted. Both exits from here create the game rather than reveal a
 * game that was already sitting there: hot-seat calls createInitialState()
 * at the moment of the click, and online leaves the seeding to whichever
 * client gets there first (handleRoomUpdate), once both seats are filled.
 */

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
    onlineRoom.leave({ departed: true });
    onlineRoom = null;
    onlineColor = null;
    latestRoom = null;
    currentRoomCode = null;
    qrRenderedForRoom = null;
    roomDetailsOpen = false;
    roomStatusEl.hidden = true;
    qrPanelEl.hidden = true;
    document.body.classList.remove('online');
  }

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
  const code = lastRoomCode();
  rejoinButton.hidden = !code;
  rejoinCodeEl.textContent = code || '';
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
  const you = onlineColor === 'spectator' ? 'Spectating' : `You are ${onlineColor === 'white' ? 'White' : 'Black'}`;

  let status = '';
  if (onlineColor !== 'spectator') {
    if (!seatTaken) {
      status = ' — waiting for opponent…';
    } else if (otherDeparted) {
      /* Checked before presence: leaving clears presence too, so an
         opponent who quit satisfies both conditions and the more
         specific one has to win. */
      status = ' — opponent left the game';
    } else if (!otherPresent) {
      status = ' — opponent disconnected';
    }
  }
  roomInfoEl.textContent = `Room ${currentRoomCode} · ${you}${status}`;
  roomStatusEl.classList.toggle('room-status--warning', otherDeparted || (seatTaken && !otherPresent));

  /* Nothing left to actively report (opponent present and connected, or
     spectating) - the Copy link/QR row isn't needed anymore, so collapse
     it to just the room code, restorable via roomChipEl's click handler. */
  const collapsed = status === '';
  roomStatusEl.classList.toggle('room-status--collapsed', collapsed);
  roomChipEl.hidden = !collapsed;
  roomChipEl.textContent = currentRoomCode;
  roomDetailsEl.hidden = collapsed && !roomDetailsOpen;

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
  onlineColor = color;
  latestRoom = room;
  setBoardPerspective(color);
  renderRoomStatus(room);

  if (room.state == null) {
    if (color === 'white' && bothSeatsClaimed(room)) {
      onlineRoom.sendState(createInitialState());
    }
    return;
  }

  state = room.state;
  selectedFrom = null;
  render();
}

function startOnline(roomCode) {
  currentRoomCode = roomCode;
  rememberRoom(roomCode);
  leaveStartScreen();
  /* Tells style.css this game has a room status row to make space for.
     Without it .online-area is hidden and the board claims that height
     instead (see --online-row). */
  document.body.classList.add('online');
  roomStatusEl.hidden = false;
  onlineRoom = joinRoom(roomCode, { onRoom: handleRoomUpdate });
}

playOnlineButton.addEventListener('click', () => {
  const roomCode = randomRoomCode();
  location.hash = `room=${roomCode}`;
  startOnline(roomCode);
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

roomChipEl.addEventListener('click', () => {
  roomDetailsOpen = !roomDetailsOpen;
  renderRoomStatus(latestRoom);
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
