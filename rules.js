/* Game rules and state.
 *
 * Nothing in this file touches the DOM. The board is a plain object that can
 * be serialized to JSON, which is what makes these rules testable without a
 * browser and (later) syncable between two players.
 *
 * Board numbering is 1-24 absolute, not per-player: White's home is 1-6 and
 * White moves toward decreasing numbers; Black's home is 19-24 and Black
 * moves toward increasing numbers. The bar acts as position 25 for White and
 * position 0 for Black, which is where entryPoint and pipsFromOff come from.
 *
 * Checkers are interchangeable - only the count and color on each point
 * matter - so a point is just { color, count } or null when empty.
 */

const POINT_COUNT = 24;
const CHECKERS_PER_PLAYER = 15;
const BAR_PIPS = 25;

/* from/to use point numbers, plus these two sentinels for the off-board
   places a checker can sit. */
const BAR = 'bar';
const OFF = 'off';

/* A game has two phases. `opening` is the standard procedure for deciding
   who starts - each player rolls one die, high roll starts, a tie is
   rerolled - and `playing` is everything after it. The phase is stored
   rather than derived: it could be worked out from openingRoll's contents,
   but the rule ("both values present and equal means a tie, present and
   different means we already left") is exactly the kind of implicit
   invariant that goes wrong quietly later.

   The rolls are made by the players rather than generated with the board,
   which is the whole point: arriving at a game whose dice were already
   thrown by nobody is confusing, and online it means the first thing you
   do in a shared game is something you actually did.

   During `opening`, `currentPlayer` is a placeholder and means nothing -
   both players may roll, in either order. It only becomes meaningful when
   the phase resolves. */
const PHASE_OPENING = 'opening';
const PHASE_PLAYING = 'playing';

function initialPoints() {
  const points = new Array(POINT_COUNT + 1).fill(null);
  points[1] = { color: 'black', count: 2 };
  points[6] = { color: 'white', count: 5 };
  points[8] = { color: 'white', count: 3 };
  points[12] = { color: 'black', count: 5 };
  points[13] = { color: 'white', count: 5 };
  points[17] = { color: 'black', count: 3 };
  points[19] = { color: 'black', count: 5 };
  points[24] = { color: 'white', count: 2 };
  return points;
}

/* Deterministic now, and deliberately so - nothing is rolled until a
   player rolls it. That also defuses the re-roll-until-favourable problem
   that gating the online seed on both seats was guarding against: a fresh
   game no longer contains a roll to be unhappy with. */
function createInitialState() {
  return {
    points: initialPoints(),
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    dice: [],
    currentPlayer: 'white',
    winner: null,
    phase: PHASE_OPENING,
    openingRoll: { white: null, black: null },
  };
}

/* True once both opening dice are showing but neither player has started -
   i.e. the pair tied. Distinguishable from a resolved opening because
   resolveOpening leaves the phase as `opening` only in that case. */
function isOpeningTie(state) {
  return (
    state.phase === PHASE_OPENING &&
    state.openingRoll.white !== null &&
    state.openingRoll.black !== null
  );
}

/* Rolls one player's opening die. A no-op if the phase is over or that
   player has already rolled this round, so a double-tap or a duplicate
   broadcast can't overwrite a die that's already showing.

   A tied pair is left on screen rather than cleared immediately, so both
   players actually see the tie that cost them a round; whoever rolls next
   clears it and starts a fresh round. */
function rollOpeningDie(state, color, randomFn) {
  if (state.phase !== PHASE_OPENING) {
    return state;
  }
  if (!isOpeningTie(state) && state.openingRoll[color] !== null) {
    return state;
  }

  const random = randomFn || Math.random;
  const next = cloneState(state);
  if (isOpeningTie(state)) {
    next.openingRoll = { white: null, black: null };
  }
  next.openingRoll[color] = Math.floor(random() * 6) + 1;
  return resolveOpening(next);
}

/* Once both dice are in and differ, the higher one starts and the two
   individual values become that turn's dice - same as any other turn, no
   special doubles handling, since a tie is the only way they could match
   and a tie doesn't resolve. */
function resolveOpening(state) {
  const { white, black } = state.openingRoll;
  if (white === null || black === null || white === black) {
    return state;
  }

  const next = cloneState(state);
  next.phase = PHASE_PLAYING;
  next.currentPlayer = white > black ? 'white' : 'black';
  next.dice = [
    { value: white, played: false },
    { value: black, played: false },
  ];
  return next;
}

function cloneState(state) {
  return {
    points: state.points.map((p) => (p ? { color: p.color, count: p.count } : null)),
    bar: { ...state.bar },
    off: { ...state.off },
    dice: state.dice.map((d) => ({ ...d })),
    currentPlayer: state.currentPlayer,
    winner: state.winner,
    phase: state.phase,
    openingRoll: state.openingRoll ? { ...state.openingRoll } : null,
  };
}

function opponentOf(color) {
  return color === 'white' ? 'black' : 'white';
}

function entryPoint(color, dieValue) {
  return color === 'white' ? BAR_PIPS - dieValue : dieValue;
}

function pipsFromOff(color, pointNumber) {
  return color === 'white' ? pointNumber : BAR_PIPS - pointNumber;
}

function isInHome(color, pointNumber) {
  return color === 'white' ? pointNumber <= 6 : pointNumber >= 19;
}

/* Where a checker lands moving `dieValue` from `pointNumber`, following the
   color's own direction. May fall outside 1-24, which callers treat as
   bear-off territory rather than a normal destination. */
function destinationFrom(color, pointNumber, dieValue) {
  return color === 'white' ? pointNumber - dieValue : pointNumber + dieValue;
}

function pointsWithColor(state, color) {
  const result = [];
  for (let n = 1; n <= POINT_COUNT; n++) {
    if (state.points[n] && state.points[n].color === color) {
      result.push(n);
    }
  }
  return result;
}

function countAt(state, pointNumber, color) {
  const point = state.points[pointNumber];
  return point && point.color === color ? point.count : 0;
}

function pipCount(state, color) {
  const onBoard = pointsWithColor(state, color).reduce(
    (sum, n) => sum + pipsFromOff(color, n) * state.points[n].count,
    0
  );
  return onBoard + state.bar[color] * BAR_PIPS;
}

function availableDice(state) {
  return state.dice.filter((die) => !die.played);
}

function isHomeReady(state, color) {
  if (state.bar[color] > 0) {
    return false;
  }
  return pointsWithColor(state, color).every((n) => isInHome(color, n));
}

/* True when no checker of this color is further from bearing off than `pips`.
   Backs the overage rule: a die larger than needed may only bear off the
   farthest-back checker. */
function isFarthestCheckerPips(state, color, pips) {
  return !pointsWithColor(state, color).some((n) => pipsFromOff(color, n) > pips);
}

/* Single source of truth for direction and blocking. `from` may be BAR;
   `to` is always a point number here (bear-off is handled separately). */
function isValidMove(state, color, from, to) {
  if (to < 1 || to > POINT_COUNT) {
    return { legal: false, hit: false };
  }

  if (from !== BAR) {
    const movingForward = color === 'white' ? to < from : to > from;
    if (!movingForward) {
      return { legal: false, hit: false };
    }
  }

  const opposing = countAt(state, to, opponentOf(color));
  if (opposing >= 2) {
    return { legal: false, hit: false };
  }

  return { legal: true, hit: opposing === 1 };
}

function canBearOffFrom(state, color, pointNumber, dieValue) {
  if (!isHomeReady(state, color)) {
    return false;
  }
  if (countAt(state, pointNumber, color) === 0) {
    return false;
  }

  const pips = pipsFromOff(color, pointNumber);
  if (dieValue === pips) {
    return true;
  }
  return dieValue > pips && isFarthestCheckerPips(state, color, pips);
}

/* The die a checker on `pointNumber` would use to bear off: an exact match
   when one is available, otherwise a larger one under the overage rule. */
function findBearOffDie(state, color, pointNumber) {
  const dice = availableDice(state);
  const pips = pipsFromOff(color, pointNumber);

  const exact = dice.find((die) => die.value === pips);
  if (exact) {
    return exact;
  }
  if (!isFarthestCheckerPips(state, color, pips)) {
    return null;
  }
  return dice.find((die) => die.value > pips) || null;
}

function canBearOffWithValue(state, color, value) {
  if (!isHomeReady(state, color)) {
    return false;
  }
  return pointsWithColor(state, color).some((n) => canBearOffFrom(state, color, n, value));
}

/* Every place a checker at `from` could legally go with the dice still
   available. Returns point numbers, plus OFF when bearing off is possible.
   Backs both the Hints display and the rule that a checker with no legal
   move can't be selected. */
function getLegalDestinations(state, color, from) {
  const destinations = new Set();

  if (from === BAR) {
    availableDice(state).forEach((die) => {
      const to = entryPoint(color, die.value);
      if (isValidMove(state, color, BAR, to).legal) {
        destinations.add(to);
      }
    });
    return [...destinations];
  }

  /* A checker on the bar must come in before anything else moves. */
  if (state.bar[color] > 0) {
    return [];
  }

  availableDice(state).forEach((die) => {
    const to = destinationFrom(color, from, die.value);
    if (isValidMove(state, color, from, to).legal) {
      destinations.add(to);
    }
  });

  if (isHomeReady(state, color) && findBearOffDie(state, color, from)) {
    destinations.add(OFF);
  }

  return [...destinations];
}

/* Whether `value` has any legal use at all for this color. Bar checkers take
   priority: if any exist, only entry legality counts, because nothing else
   may move until the bar is clear. */
function canUseDie(state, color, value) {
  if (state.bar[color] > 0) {
    return isValidMove(state, color, BAR, entryPoint(color, value)).legal;
  }

  const hasNormalMove = pointsWithColor(state, color).some((n) => {
    const to = destinationFrom(color, n, value);
    return isValidMove(state, color, n, to).legal;
  });

  return hasNormalMove || canBearOffWithValue(state, color, value);
}

function hasAnyLegalMove(state, color) {
  return availableDice(state).some((die) => canUseDie(state, color, die.value));
}

function removeChecker(state, pointNumber) {
  const point = state.points[pointNumber];
  point.count -= 1;
  if (point.count === 0) {
    state.points[pointNumber] = null;
  }
}

function addChecker(state, pointNumber, color) {
  const point = state.points[pointNumber];
  if (point && point.color === color) {
    point.count += 1;
  } else {
    state.points[pointNumber] = { color, count: 1 };
  }
}

/* Resolves a move to the die it would consume, or null when illegal. Kept
   separate from applyMove so the click handler can reject a move without
   having to build a candidate state first. */
function findDieForMove(state, color, from, to) {
  const dice = availableDice(state);

  if (to === OFF) {
    return from === BAR ? null : findBearOffDie(state, color, from);
  }

  if (from === BAR) {
    return dice.find((die) => entryPoint(color, die.value) === to) || null;
  }

  const distance = Math.abs(to - from);
  return dice.find((die) => die.value === distance) || null;
}

function isMoveLegal(state, color, from, to) {
  if (state.winner) {
    return false;
  }
  if (color !== state.currentPlayer) {
    return false;
  }
  if (from !== BAR && state.bar[color] > 0) {
    return false;
  }
  if (!findDieForMove(state, color, from, to)) {
    return false;
  }

  if (to === OFF) {
    const die = findBearOffDie(state, color, from);
    return Boolean(die) && canBearOffFrom(state, color, from, die.value);
  }

  if (from !== BAR && countAt(state, from, color) === 0) {
    return false;
  }
  if (from === BAR && state.bar[color] === 0) {
    return false;
  }

  return isValidMove(state, color, from, to).legal;
}

/* Returns a new state with the move applied - the caller's state is never
   mutated, so a rejected move can't leave a half-applied board behind.
   `hit` in the result tells the renderer whether a checker went to the bar. */
function applyMove(state, color, from, to) {
  if (!isMoveLegal(state, color, from, to)) {
    return { ok: false, state, hit: false };
  }

  const next = cloneState(state);
  const die = findDieForMove(next, color, from, to);
  let hit = false;

  if (from === BAR) {
    next.bar[color] -= 1;
  } else {
    removeChecker(next, from);
  }

  if (to === OFF) {
    next.off[color] += 1;
  } else {
    if (countAt(next, to, opponentOf(color)) === 1) {
      hit = true;
      next.points[to] = null;
      next.bar[opponentOf(color)] += 1;
    }
    addChecker(next, to, color);
  }

  die.played = true;

  if (next.off[color] === CHECKERS_PER_PLAYER) {
    next.winner = color;
  }

  return { ok: true, state: next, hit };
}

function isGameWon(state, color) {
  return state.off[color] === CHECKERS_PER_PLAYER;
}

function rollValues(randomFn) {
  const random = randomFn || Math.random;
  const first = Math.floor(random() * 6) + 1;
  const second = Math.floor(random() * 6) + 1;
  return first === second ? [first, first, first, first] : [first, second];
}

function withRoll(state, values) {
  const next = cloneState(state);
  next.dice = values.map((value) => ({ value, played: false }));
  return next;
}

function endTurn(state) {
  const next = cloneState(state);
  next.currentPlayer = opponentOf(state.currentPlayer);
  next.dice = [];
  next.openingRoll = null;
  return next;
}

/* Total checkers of a color across every location. Always 15 in a valid
   state - used by the tests as an invariant that no move loses a checker. */
function totalCheckers(state, color) {
  const onBoard = pointsWithColor(state, color).reduce((sum, n) => sum + state.points[n].count, 0);
  return onBoard + state.bar[color] + state.off[color];
}

/* ---- Checking a state that arrived from somewhere else (stage 7c) ------
 *
 * Until the lobby existed, a room could only be reached by someone who had
 * been sent its code, so trusting whatever arrived was a fair
 * simplification. Matchmaking seats you with strangers, and sendState
 * broadcasts whole snapshots that any seated client may write - including
 * one that declares them the winner.
 *
 * These functions do not make cheating impossible. A determined opponent
 * can still refuse *your* states, or desync deliberately. What they stop is
 * the crude version - spawning checkers, moving your pieces, claiming a win
 * outright - and they catch genuine sync bugs on the way.
 *
 * The governing bias throughout: reject only what is definitely impossible.
 * A false rejection breaks a legitimate game, which is a worse outcome than
 * the cheating it would have prevented. Hence monotonicity checks rather
 * than an attempt to replay the exact sequence of moves, which would be far
 * more code and far likelier to refuse something legal.
 */

/* A turn holds one die, two, or four (doubles); zero between turns. */
const POSSIBLE_DICE_COUNTS = [0, 1, 2, 4];

function isCount(value, min) {
  return Number.isInteger(value) && value >= min;
}

function hasValidPoints(state) {
  if (!Array.isArray(state.points) || state.points.length !== POINT_COUNT + 1) {
    return false;
  }
  /* Index 0 is not a point - the array is 1-based so that a point number
     indexes it directly. */
  if (state.points[0] !== null && state.points[0] !== undefined) {
    return false;
  }
  for (let n = 1; n <= POINT_COUNT; n++) {
    const point = state.points[n];
    if (point === null || point === undefined) {
      continue;
    }
    if (point.color !== 'white' && point.color !== 'black') {
      return false;
    }
    /* An empty point is null, never { count: 0 } - a zero-count point would
       let a tampered state hide a checker's disappearance from a naive
       count. */
    if (!isCount(point.count, 1)) {
      return false;
    }
  }
  return true;
}

function hasValidDice(state) {
  if (!Array.isArray(state.dice) || !POSSIBLE_DICE_COUNTS.includes(state.dice.length)) {
    return false;
  }
  const allSixSided = state.dice.every(
    (die) => Number.isInteger(die.value) && die.value >= 1 && die.value <= 6 && typeof die.played === 'boolean'
  );
  if (!allSixSided) {
    return false;
  }
  /* Four dice only ever come from doubles, so they must all match. */
  return state.dice.length !== 4 || state.dice.every((die) => die.value === state.dice[0].value);
}

/* Properties every state this engine produces satisfies. Nothing here
   depends on what came before, so it can be applied to the very first
   state a client receives. */
function isStructurallyValid(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }
  if (state.phase !== PHASE_OPENING && state.phase !== PHASE_PLAYING) {
    return false;
  }
  if (state.currentPlayer !== 'white' && state.currentPlayer !== 'black') {
    return false;
  }
  if (state.winner !== null && state.winner !== 'white' && state.winner !== 'black') {
    return false;
  }
  if (!state.bar || !state.off || !hasValidPoints(state) || !hasValidDice(state)) {
    return false;
  }

  for (const color of ['white', 'black']) {
    if (!isCount(state.bar[color], 0) || !isCount(state.off[color], 0)) {
      return false;
    }
    /* The strongest single check here: checkers cannot be conjured or
       destroyed, so any state claiming otherwise was not produced by
       applyMove. */
    if (totalCheckers(state, color) !== CHECKERS_PER_PLAYER) {
      return false;
    }
  }

  /* Declaring yourself the winner without having borne anything off is the
     crudest attack there is, and this is where it stops. */
  if (state.winner && state.off[state.winner] !== CHECKERS_PER_PLAYER) {
    return false;
  }

  if (state.phase === PHASE_OPENING) {
    if (state.dice.length !== 0 || !state.openingRoll) {
      return false;
    }
    for (const color of ['white', 'black']) {
      const value = state.openingRoll[color];
      if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 6)) {
        return false;
      }
    }
  }

  return true;
}

/* JSON with object keys in a fixed order, for comparing two states as
   strings.

   Plain JSON.stringify cannot do this job, and the difference is not
   cosmetic. It serialises keys in insertion order, while Firebase returns
   a record's keys sorted - so a state that has been through the database
   never matches the identical state built locally. createInitialState
   writes `{ white: 0, black: 0 }`; the same object read back reads
   `{ black: 0, white: 0 }`. Identical boards, different strings.

   That is exactly what stopped an online restart from being recognised as
   one: the fresh game arrived, isFreshStart said no, and the monotonic
   checks then refused it for putting every checker back to the start -
   which no move can do. Both players were left staring at a finished game
   with a Play Again button that did nothing. */
function canonicalJson(value) {
  if (value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
      .join(',');
    return '{' + body + '}';
  }
  return JSON.stringify(value);
}

/* A restart, which either player may perform at any time. createInitialState
   is deterministic now that the opening roll belongs to the players, so a
   fresh game is a single exact value to compare against - as long as the
   comparison survives a round trip through the database, which is what
   canonicalJson above is for. */
function isFreshStart(state) {
  return canonicalJson(state) === canonicalJson(createInitialState());
}

/* Could `next` have come from `previous` by anything the game allows?
 *
 * `seen` is a list of recently accepted states, as JSON, and covers two
 * cases at once: Firebase echoing a client's own writes back to it, and an
 * undo - which reverts to a state that was broadcast a moment ago, and so
 * is far easier to recognise by memory than by reasoning backwards through
 * a move.
 */
function isLegalSuccessor(previous, next, seen) {
  if (!isStructurallyValid(next)) {
    return false;
  }
  if (!previous) {
    return true;
  }
  if (seen && seen.indexOf(canonicalJson(next)) !== -1) {
    return true;
  }
  if (isFreshStart(next)) {
    return true;
  }

  const mover = previous.currentPlayer;
  const idle = opponentOf(mover);

  /* Only the player on turn may move, so the other one cannot have gained
     ground: they may be sent backwards by being hit, never forwards, and
     they certainly cannot bear off. This is what a fabricated win runs
     into. */
  if (next.off[idle] > previous.off[idle]) {
    return false;
  }
  if (pipCount(next, idle) < pipCount(previous, idle)) {
    return false;
  }

  /* And the player on turn cannot go backwards (nothing can hit them on
     their own turn) nor bear off more than a turn's worth of dice. */
  if (pipCount(next, mover) > pipCount(previous, mover)) {
    return false;
  }
  if (next.off[mover] > previous.off[mover] + 4) {
    return false;
  }

  return true;
}

/* ---- Explaining a refusal (item 3) ------------------------------------
 *
 * A click that does nothing is the most confusing thing the board can do
 * to someone still learning the rules, and four separate rules can produce
 * one. These say which, as a code the UI turns into a sentence.
 *
 * They live here rather than in script.js because they are rules, not
 * presentation: what stops you picking up a checker is exactly what the
 * engine already knows about it. Being pure, the reasons are testable
 * without a browser.
 */
const SELECT_NOT_YOUR_TURN = 'not-your-turn';
const SELECT_NO_DICE = 'no-dice';
const SELECT_BAR_FIRST = 'bar-first';
const SELECT_NO_MOVES = 'no-moves';

/* Ordered most fundamental first, so the answer is the one worth acting
   on: there is no point being told a checker has nowhere to go when the
   real problem is that you have not rolled yet. */
function selectionProblem(state, color, from) {
  if (color !== state.currentPlayer) {
    return SELECT_NOT_YOUR_TURN;
  }
  if (availableDice(state).length === 0) {
    return SELECT_NO_DICE;
  }
  if (state.bar[color] > 0 && from !== BAR) {
    return SELECT_BAR_FIRST;
  }
  if (getLegalDestinations(state, color, from).length === 0) {
    return SELECT_NO_MOVES;
  }
  return null;
}

/* Whether `color` had a checker sent to the bar between these two states.
   The player being hit has no other cue that it happened - online the
   board simply changes under them - so the receiving client works it out
   by comparison rather than being told. */
function wasHit(previous, next, color) {
  if (!previous || !next) {
    return false;
  }
  return next.bar[color] > previous.bar[color];
}
