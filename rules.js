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

/* Standard opening procedure: each player rolls one die, high roll starts,
   a tie is rerolled. The starting player's first turn then uses both of
   these individual die values as its dice - same as any other turn, no
   special doubles handling, since a tie (the only way the two values could
   match) is exactly what got rerolled away. */
function rollOpeningRoll(randomFn) {
  const random = randomFn || Math.random;
  let white;
  let black;
  do {
    white = Math.floor(random() * 6) + 1;
    black = Math.floor(random() * 6) + 1;
  } while (white === black);
  return { white, black, starter: white > black ? 'white' : 'black' };
}

function createInitialState(randomFn) {
  const points = new Array(POINT_COUNT + 1).fill(null);
  points[1] = { color: 'black', count: 2 };
  points[6] = { color: 'white', count: 5 };
  points[8] = { color: 'white', count: 3 };
  points[12] = { color: 'black', count: 5 };
  points[13] = { color: 'white', count: 5 };
  points[17] = { color: 'black', count: 3 };
  points[19] = { color: 'black', count: 5 };
  points[24] = { color: 'white', count: 2 };

  const opening = rollOpeningRoll(randomFn);

  return {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    dice: [
      { value: opening.white, played: false },
      { value: opening.black, played: false },
    ],
    currentPlayer: opening.starter,
    winner: null,
    openingRoll: { white: opening.white, black: opening.black },
  };
}

function cloneState(state) {
  return {
    points: state.points.map((p) => (p ? { color: p.color, count: p.count } : null)),
    bar: { ...state.bar },
    off: { ...state.off },
    dice: state.dice.map((d) => ({ ...d })),
    currentPlayer: state.currentPlayer,
    winner: state.winner,
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
