/* DOM wiring and rendering.
 *
 * All game rules and state live in rules.js, which never touches the DOM.
 * This file's job is the other half: turn clicks into moves, and turn the
 * resulting state back into checkers on screen.
 *
 * `state` is the single source of truth - the DOM is derived from it, never
 * read for game logic. `selectedFrom` and `hintsEnabled` are the only other
 * local state; `onlineRoom`/`onlineColor` (see the Online play section
 * below) are local too, in the sense that they describe this tab's
 * connection, not the shared game.
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
const gameOverEl = document.querySelector('#game-over');
const turnIndicator = document.querySelector('#turn-indicator');
const messageEl = document.querySelector('#message');
const hintsToggle = document.querySelector('#hints-toggle');
const pipCountEl = document.querySelector('#pip-count');
const playOnlineButton = document.querySelector('#play-online-button');
const preJoinAreaEl = document.querySelector('#pre-join-area');
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

/* White re-enters on points 19-24 (top row) and Black on 1-6 (bottom row),
   so each colour waits on the bar nearest where it will come back in. */
const barContainers = {
  white: document.querySelector('.board-row.top .bar-checkers'),
  black: document.querySelector('.board-row.bottom .bar-checkers'),
};

const offContainers = {
  white: document.querySelector('.off[data-owner="white"] .off-checkers'),
  black: document.querySelector('.off[data-owner="black"] .off-checkers'),
};

const offCountEls = {
  white: document.querySelector('.off-count[data-owner="white"]'),
  black: document.querySelector('.off-count[data-owner="black"]'),
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

let state = createInitialState();
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
    layout.set(pointElement(n), point ? { color: point.color, count: point.count } : { color: null, count: 0 });
  }

  layout.set(barContainers.white, { color: 'white', count: state.bar.white });
  layout.set(barContainers.black, { color: 'black', count: state.bar.black });
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

function createDie(die, usable) {
  const element = document.createElement('div');
  element.className = 'die';
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

function renderDice() {
  diceContainer.innerHTML = '';
  state.dice.forEach((die) => {
    diceContainer.appendChild(createDie(die, canUseDie(state, state.currentPlayer, die.value)));
  });
  rollButton.disabled = state.dice.length > 0 || Boolean(state.winner) || blockedOnline();
}

function renderStatus() {
  const turnText = `${state.currentPlayer === 'white' ? 'White' : 'Black'}'s turn`;
  turnIndicator.textContent = state.openingRoll
    ? `${turnText} — opening roll: White ${state.openingRoll.white}, Black ${state.openingRoll.black}`
    : turnText;
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
  if (state.winner || blockedOnline()) {
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
  if (state.dice.length > 0 || state.winner || blockedOnline()) {
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
  return onlineColor !== state.currentPlayer;
}

/* Both seats claimed - i.e. an opponent has shown up at least once (seats
   are never freed, so this doesn't require them to still be connected; see
   the presence discussion above). Used to gate anything that generates a
   fresh opening roll (the initial seed in handleRoomUpdate, and Restart):
   otherwise the room's creator, alone in the room, could keep generating
   opening rolls with nobody else watching and only broadcast once one
   favors them - see handleRoomUpdate below for why the seed itself needs
   the same guard. */
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
  const you = onlineColor === 'spectator' ? 'Spectating' : `You are ${onlineColor === 'white' ? 'White' : 'Black'}`;

  let status = '';
  if (onlineColor !== 'spectator') {
    if (!seatTaken) {
      status = ' — waiting for opponent…';
    } else if (!otherPresent) {
      status = ' — opponent disconnected';
    }
  }
  roomInfoEl.textContent = `Room ${currentRoomCode} · ${you}${status}`;
  roomStatusEl.classList.toggle('room-status--warning', status === ' — opponent disconnected');

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

   Seeding waits for both seats deliberately: seeding it the moment White
   alone creates the room would let White see the opening roll - and
   Restart to re-roll it - with nobody else in the room to notice, before
   Black ever shows up. Gating on bothSeatsClaimed (also enforced in
   restartGame) means the opening roll only ever happens with both players
   present to see it, same as any later restart.

   `== null` rather than `=== null`: Firebase never actually stores a null
   value - a key written as null is simply absent from what a listener
   receives back, so a freshly-created room's `state` arrives as undefined,
   not null. `== null` matches both. */
function handleRoomUpdate(room, color) {
  onlineColor = color;
  latestRoom = room;
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
  preJoinAreaEl.hidden = true;
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
    showMessage('Enter a 6-character room code.');
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
const roomFromUrl = location.hash.match(/room=([A-Z0-9]{6})/i);
if (roomFromUrl) {
  startOnline(roomFromUrl[1].toUpperCase());
}

render();
