/* Tests for rules.js and sync.js.
 *
 * Open tests.html in a browser to run them. No framework and no build step -
 * the whole runner is the ~40 lines below, matching the project's no-tooling
 * constraint. rules.js never touches the DOM, so most of this is a plain
 * function call on a plain object; the sync.js tests do touch localStorage
 * and BroadcastChannel; and go via a fresh random room code each time so
 * runs never collide with each other.
 *
 * test() only registers a case - they all run at the end, in order, via
 * run(). That's what lets a test be async: sync.js's cross-client delivery
 * genuinely happens on a later tick (BroadcastChannel doesn't deliver
 * synchronously), so a test for it has to await something, and every test
 * needs to finish before the results can be reported.
 */

const registeredTests = [];

function test(name, fn) {
  registeredTests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message || 'not equal'} - expected ${e}, got ${a}`);
  }
}

/* Polls rather than waiting a fixed guess, so tests are both fast in the
   common case and not flaky under a slow first run. */
function waitFor(conditionFn, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (conditionFn()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(poll, 5);
    })();
  });
}

/* ---- helpers for building focused board positions ---- */

function emptyState() {
  return {
    points: new Array(25).fill(null),
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    dice: [],
    currentPlayer: 'white',
    winner: null,
  };
}

function place(state, pointNumber, color, count) {
  state.points[pointNumber] = { color, count };
  return state;
}

function withDice(state, ...values) {
  state.dice = values.map((value) => ({ value, played: false }));
  return state;
}

/* Feeds a fixed sequence of Math.random()-shaped fractions to code under
   test, one per call - unlike a constant function, this can express a tied
   opening roll followed by a differing one without looping forever. */
function sequenceRandom(values) {
  let i = 0;
  return () => values[i++];
}

/* ---- starting position ---- */

test('initial position gives each player 15 checkers', () => {
  const state = createInitialState();
  assertEqual(totalCheckers(state, 'white'), 15, 'white checkers');
  assertEqual(totalCheckers(state, 'black'), 15, 'black checkers');
});

test('initial pip count is 167 for both players', () => {
  const state = createInitialState();
  assertEqual(pipCount(state, 'white'), 167, 'white pips');
  assertEqual(pipCount(state, 'black'), 167, 'black pips');
});

/* ---- opening phase (deciding who starts) ----
 *
 * The rolls are the players', not the board's: a fresh game contains no
 * dice at all until somebody throws one. `single` feeds one fraction per
 * roll, since each call now produces exactly one die rather than looping
 * internally until the pair differs.
 */

function single(fraction) {
  return () => fraction;
}

test('a fresh game has rolled nothing and is waiting on both players', () => {
  const state = createInitialState();
  assertEqual(state.phase, 'opening');
  assertEqual(state.openingRoll, { white: null, black: null }, 'neither die thrown yet');
  assertEqual(state.dice, [], 'and no turn dice exist before the phase resolves');
});

test('one opening die leaves the game waiting for the other player', () => {
  const state = rollOpeningDie(createInitialState(), 'white', single(0.95)); // 6
  assertEqual(state.phase, 'opening', 'one die decides nothing');
  assertEqual(state.openingRoll, { white: 6, black: null });
  assertEqual(state.dice, [], 'still no turn dice');
});

test('the higher opening die starts, and both values become that turn\'s dice', () => {
  let state = createInitialState();
  state = rollOpeningDie(state, 'white', single(0.25)); // 2
  state = rollOpeningDie(state, 'black', single(0.75)); // 5

  assertEqual(state.phase, 'playing');
  assertEqual(state.currentPlayer, 'black', 'higher roll (5) starts');
  assertEqual(state.dice.map((d) => d.value), [2, 5], 'both individual rolls become the first turn\'s dice');
  assertEqual(state.openingRoll, { white: 2, black: 5 }, 'and stay for the banner');
});

test('either player may roll first', () => {
  let state = createInitialState();
  state = rollOpeningDie(state, 'black', single(0.95)); // 6
  state = rollOpeningDie(state, 'white', single(0.25)); // 2

  assertEqual(state.currentPlayer, 'black', 'order of rolling does not affect who starts');
  assertEqual(state.dice.map((d) => d.value), [2, 6], 'dice are always listed white-then-black, not in the order they were rolled');
});

test('a tie stays in the opening phase with both dice still showing', () => {
  let state = createInitialState();
  state = rollOpeningDie(state, 'white', single(0.45)); // 3
  state = rollOpeningDie(state, 'black', single(0.45)); // 3

  assertEqual(state.phase, 'opening', 'a tie decides nothing');
  assertEqual(state.openingRoll, { white: 3, black: 3 }, 'and is left on screen rather than cleared, so both players see it');
  assert(isOpeningTie(state), 'which is what makes the tie recognisable to the UI');
  assertEqual(state.dice, []);
});

test('rolling after a tie clears both dice and starts a fresh round', () => {
  let state = createInitialState();
  state = rollOpeningDie(state, 'white', single(0.45)); // 3
  state = rollOpeningDie(state, 'black', single(0.45)); // 3
  state = rollOpeningDie(state, 'white', single(0.95)); // 6

  assertEqual(state.openingRoll, { white: 6, black: null }, "the previous round's tie is cleared, not added to");
  assertEqual(state.phase, 'opening', 'still waiting on black');
});

test('rolling twice for the same player is ignored', () => {
  const first = rollOpeningDie(createInitialState(), 'white', single(0.25)); // 2
  const again = rollOpeningDie(first, 'white', single(0.95)); // would be 6

  assertEqual(again.openingRoll, { white: 2, black: null }, 'a double tap cannot overwrite a die already showing');
  assert(again === first, 'and is a no-op rather than a fresh object');
});

test('an opening die cannot be rolled once the game is under way', () => {
  let state = createInitialState();
  state = rollOpeningDie(state, 'white', single(0.25)); // 2
  state = rollOpeningDie(state, 'black', single(0.75)); // 5
  const after = rollOpeningDie(state, 'white', single(0.95));

  assert(after === state, 'the phase is over, so there is nothing to roll for');
});

test('rollOpeningDie does not mutate the state it is given', () => {
  const state = createInitialState();
  const before = JSON.stringify(state);
  rollOpeningDie(state, 'white', single(0.95));
  assertEqual(JSON.stringify(state), before, 'same purity contract as applyMove');
});

/* ---- direction ---- */

test('white moves toward lower numbers, never higher', () => {
  const state = withDice(place(emptyState(), 13, 'white', 1), 5);
  assert(isMoveLegal(state, 'white', 13, 8), 'should allow 13 -> 8');
  assert(!isMoveLegal(state, 'white', 13, 18), 'should reject 13 -> 18');
});

test('black moves toward higher numbers, never lower', () => {
  const state = withDice(place(emptyState(), 12, 'black', 1), 5);
  state.currentPlayer = 'black';
  assert(isMoveLegal(state, 'black', 12, 17), 'should allow 12 -> 17');
  assert(!isMoveLegal(state, 'black', 12, 7), 'should reject 12 -> 7');
});

/* ---- blocking and hitting ---- */

test('a point held by 2+ opposing checkers is blocked', () => {
  let state = place(emptyState(), 13, 'white', 1);
  state = place(state, 8, 'black', 2);
  state = withDice(state, 5);
  assert(!isMoveLegal(state, 'white', 13, 8), 'blocked point should reject');
});

test('landing on a lone opposing checker hits it to the bar', () => {
  let state = place(emptyState(), 13, 'white', 1);
  state = place(state, 8, 'black', 1);
  state = withDice(state, 5);

  const result = applyMove(state, 'white', 13, 8);
  assert(result.ok, 'move should succeed');
  assert(result.hit, 'should report a hit');
  assertEqual(result.state.bar.black, 1, 'black on bar');
  assertEqual(result.state.points[8], { color: 'white', count: 1 }, 'point taken over');
});

test('moving onto your own point stacks rather than hits', () => {
  let state = place(emptyState(), 13, 'white', 1);
  state = place(state, 8, 'white', 2);
  state = withDice(state, 5);

  const result = applyMove(state, 'white', 13, 8);
  assert(result.ok, 'move should succeed');
  assert(!result.hit, 'should not report a hit');
  assertEqual(result.state.points[8].count, 3, 'stacked to 3');
});

/* ---- the bar ---- */

test('entry point follows each colour direction', () => {
  assertEqual(entryPoint('white', 3), 22, 'white entry');
  assertEqual(entryPoint('black', 3), 3, 'black entry');
});

test('a checker on the bar must enter before anything else moves', () => {
  let state = place(emptyState(), 13, 'white', 2);
  state = withDice(state, 5);
  state.bar.white = 1;

  assert(!isMoveLegal(state, 'white', 13, 8), 'other moves blocked while on bar');
  assertEqual(getLegalDestinations(state, 'white', 13), [], 'no destinations while on bar');
});

test('bar entry is blocked by an opposing point', () => {
  let state = place(emptyState(), 22, 'black', 2);
  state = withDice(state, 3);
  state.bar.white = 1;
  assert(!isMoveLegal(state, 'white', 'bar', 22), 'blocked entry should reject');
});

test('bar entry can hit a blot', () => {
  let state = place(emptyState(), 22, 'black', 1);
  state = withDice(state, 3);
  state.bar.white = 1;

  const result = applyMove(state, 'white', 'bar', 22);
  assert(result.ok, 'entry should succeed');
  assert(result.hit, 'should hit the blot');
  assertEqual(result.state.bar.white, 0, 'white left the bar');
  assertEqual(result.state.bar.black, 1, 'black sent to bar');
});

test('a checker on the bar counts as 25 pips', () => {
  const state = emptyState();
  state.bar.white = 1;
  assertEqual(pipCount(state, 'white'), 25);
});

/* ---- bearing off ---- */

test('cannot bear off before all checkers are home', () => {
  let state = place(emptyState(), 3, 'white', 1);
  state = place(state, 13, 'white', 1);
  state = withDice(state, 3);
  assert(!isHomeReady(state, 'white'), 'not home ready');
  assert(!isMoveLegal(state, 'white', 3, 'off'), 'bear off should reject');
});

test('a checker on the bar blocks bearing off', () => {
  const state = withDice(place(emptyState(), 3, 'white', 1), 3);
  state.bar.white = 1;
  assert(!isHomeReady(state, 'white'), 'bar blocks home ready');
});

test('an exact die bears a checker off', () => {
  const state = withDice(place(emptyState(), 3, 'white', 2), 3);
  const result = applyMove(state, 'white', 3, 'off');
  assert(result.ok, 'bear off should succeed');
  assertEqual(result.state.off.white, 1, 'one borne off');
});

test('a larger die bears off only the farthest-back checker', () => {
  let state = place(emptyState(), 5, 'white', 1);
  state = place(state, 3, 'white', 1);
  state = withDice(state, 6);

  assert(isMoveLegal(state, 'white', 5, 'off'), 'farthest checker may use the larger die');
  assert(!isMoveLegal(state, 'white', 3, 'off'), 'a nearer checker may not');
});

test('bearing off the 15th checker wins the game', () => {
  const state = withDice(place(emptyState(), 1, 'white', 1), 1);
  state.off.white = 14;

  const result = applyMove(state, 'white', 1, 'off');
  assert(result.ok, 'bear off should succeed');
  assertEqual(result.state.winner, 'white', 'white wins');
  assert(isGameWon(result.state, 'white'), 'game reported as won');
});

/* ---- dice and forced play ---- */

test('doubles produce four dice', () => {
  const values = rollValues(() => 0.5);
  assertEqual(values.length, 4, 'four dice for doubles');
});

test('a die with no legal move anywhere is unusable', () => {
  let state = place(emptyState(), 13, 'white', 1);
  state = place(state, 8, 'black', 2);
  state = withDice(state, 5);
  assert(!canUseDie(state, 'white', 5), 'blocked die is unusable');
  assert(!hasAnyLegalMove(state, 'white'), 'no legal move at all');
});

test('a die stays usable when any checker can play it', () => {
  let state = place(emptyState(), 13, 'white', 1);
  state = place(state, 20, 'white', 1);
  state = place(state, 8, 'black', 2);
  state = withDice(state, 5);
  assert(canUseDie(state, 'white', 5), '20 -> 15 is still open');
});

test('bear-off availability counts toward a die being usable', () => {
  const state = withDice(place(emptyState(), 3, 'white', 1), 3);
  assert(canUseDie(state, 'white', 3), 'exact bear off makes the die usable');
});

/* ---- turn handling ---- */

test('ending a turn switches player and clears the dice', () => {
  const state = withDice(createInitialState(), 3, 5);
  state.currentPlayer = 'white';
  const next = endTurn(state);
  assertEqual(next.currentPlayer, 'black', 'switched to black');
  assertEqual(next.dice, [], 'dice cleared');
});

test('ending a turn also clears the opening-roll banner', () => {
  const state = withDice(createInitialState(), 3, 5);
  state.openingRoll = { white: 6, black: 2 };
  const next = endTurn(state);
  assertEqual(next.openingRoll, null, 'opening roll no longer shown once the first turn is over');
});

test('a player cannot move on the opponent turn', () => {
  const state = withDice(place(emptyState(), 12, 'black', 1), 5);
  assert(!isMoveLegal(state, 'black', 12, 17), 'black may not move on white turn');
});

test('a move consumes exactly one die', () => {
  const state = withDice(place(emptyState(), 13, 'white', 1), 5, 3);
  const result = applyMove(state, 'white', 13, 8);
  assertEqual(availableDice(result.state).length, 1, 'one die left');
  assertEqual(availableDice(result.state)[0].value, 3, 'the 3 remains');
});

/* ---- validating a state that arrived from somewhere else (stage 7c) ----
 *
 * The lobby seats you with strangers, and sendState broadcasts whole
 * snapshots any seated client may write. These are the checks that stand
 * between an opponent and a fabricated board.
 */

function playingState(mutate) {
  const state = createInitialState();
  state.phase = 'playing';
  state.openingRoll = null;
  state.currentPlayer = 'white';
  state.dice = [{ value: 3, played: false }, { value: 5, played: false }];
  if (mutate) {
    mutate(state);
  }
  return state;
}

test('states this engine produces are structurally valid', () => {
  assert(isStructurallyValid(createInitialState()), 'a fresh game');
  assert(isStructurallyValid(playingState()), 'a game under way');

  const moved = applyMove(playingState(), 'white', 8, 5);
  assert(moved.ok && isStructurallyValid(moved.state), 'the result of a legal move');
  assert(isStructurallyValid(endTurn(playingState())), 'the result of ending a turn');
});

test('a state with the wrong number of checkers is rejected', () => {
  const extra = playingState((s) => { s.points[10] = { color: 'white', count: 1 }; });
  assert(!isStructurallyValid(extra), '16 white checkers cannot be right');

  const missing = playingState((s) => { s.points[6] = { color: 'white', count: 4 }; });
  assert(!isStructurallyValid(missing), 'and neither can 14');
});

test('structurally impossible boards are rejected', () => {
  assert(!isStructurallyValid(playingState((s) => { s.points[10] = { color: 'white', count: 0 }; })),
    'an empty point is null, never a zero count - which would hide a missing checker from a naive tally');
  assert(!isStructurallyValid(playingState((s) => { s.bar.white = -1; })), 'negative bar');
  assert(!isStructurallyValid(playingState((s) => { s.phase = 'whatever'; })), 'unknown phase');
  assert(!isStructurallyValid(playingState((s) => { s.currentPlayer = 'green'; })), 'unknown player');
});

test('impossible dice are rejected', () => {
  assert(!isStructurallyValid(playingState((s) => { s.dice = [{ value: 7, played: false }]; })), 'a seven');
  assert(!isStructurallyValid(playingState((s) => { s.dice = [{ value: 0, played: false }]; })), 'a zero');
  assert(!isStructurallyValid(playingState((s) => {
    s.dice = [1, 2, 3].map((v) => ({ value: v, played: false }));
  })), 'three dice - a turn holds one, two or four');
  assert(!isStructurallyValid(playingState((s) => {
    s.dice = [2, 2, 2, 5].map((v) => ({ value: v, played: false }));
  })), 'four dice that are not all the same, since four can only come from doubles');
  assert(isStructurallyValid(playingState((s) => {
    s.dice = [2, 2, 2, 2].map((v) => ({ value: v, played: false }));
  })), 'but genuine doubles are fine');
});

/* The crudest attack there is, and the one most worth catching. */
test('declaring yourself the winner without bearing off is rejected', () => {
  const claim = playingState((s) => { s.winner = 'black'; });
  assert(!isStructurallyValid(claim), 'a winner must actually have all fifteen off');
});

test('a legal step forward is accepted', () => {
  const before = playingState();
  const moved = applyMove(before, 'white', 8, 5);
  assert(isLegalSuccessor(before, moved.state, []), 'a move by the player on turn');
  assert(isLegalSuccessor(before, endTurn(before), []), 'ending the turn');
  assert(isLegalSuccessor(createInitialState(), rollOpeningDie(createInitialState(), 'white', () => 0.5), []),
    'an opening die');
});

test('a restart is accepted from anywhere', () => {
  const midGame = applyMove(playingState(), 'white', 8, 5).state;
  assert(isLegalSuccessor(midGame, createInitialState(), []), 'either player may restart at any time');
});

test('an unchanged state is accepted, since Firebase echoes your own writes back', () => {
  const state = playingState();
  assert(isLegalSuccessor(state, state, []), 'a client must accept the return of its own broadcast');
});

/* The fabricated win, done properly - fifteen off and the checkers removed,
   so the count still balances and structural validity alone would pass it. */
test('an opponent cannot bear off while it is not their turn', () => {
  const before = playingState();
  const fake = playingState((s) => {
    for (let n = 1; n <= 24; n++) {
      if (s.points[n] && s.points[n].color === 'black') {
        s.points[n] = null;
      }
    }
    s.off.black = 15;
    s.winner = 'black';
  });

  assert(isStructurallyValid(fake), 'it balances, so the structural checks alone let it through');
  assert(!isLegalSuccessor(before, fake, []), 'but black cannot bear off fifteen checkers on white\'s turn');
});

test('an opponent cannot advance their own checkers out of turn', () => {
  const before = playingState();
  const sneaky = playingState((s) => {
    /* Black moves 24 -> 22, which is forward for black and so lowers their
       pip count, on a turn that belongs to white. */
    s.points[1] = { color: 'black', count: 1 };
    s.points[3] = { color: 'black', count: 1 };
  });
  assert(pipCount(sneaky, 'black') < pipCount(before, 'black'), 'the state does put black ahead');
  assert(!isLegalSuccessor(before, sneaky, []), 'which cannot have happened while white was on turn');
});

test('being hit is allowed, since it sends the idle player backwards not forwards', () => {
  /* One black checker moved from its opening point to 5, leaving a blot -
     the count has to stay at fifteen or the structural checks reject the
     setup before the interesting rule is ever reached. */
  const before = playingState((s) => {
    s.points[1] = { color: 'black', count: 1 };
    s.points[5] = { color: 'black', count: 1 };
  });
  const hit = applyMove(before, 'white', 8, 5);
  assert(hit.ok && hit.hit, 'the move hits');
  assert(isLegalSuccessor(before, hit.state, []), 'a hit raises the idle player\'s pips, which is legal');
});

test('an undo is accepted by memory, being a state already seen', () => {
  const before = playingState();
  const moved = applyMove(before, 'white', 8, 5).state;

  assert(!isLegalSuccessor(moved, before, []), 'reverting looks impossible on its own');
  assert(isLegalSuccessor(moved, before, [JSON.stringify(before)]),
    'but is recognised when the state was broadcast a moment ago');
});

test('a revert to a state never seen is rejected', () => {
  const before = playingState();
  const moved = applyMove(before, 'white', 8, 5).state;
  /* A white checker dragged backwards, to 9 from 6 - white moves toward
     lower numbers, so this raises white's pip count. Genuinely different
     from `before`, and never broadcast, so memory cannot excuse it. */
  const invented = playingState((s) => {
    s.points[6] = { color: 'white', count: 4 };
    s.points[9] = { color: 'white', count: 1 };
  });

  assert(!isLegalSuccessor(moved, invented, [JSON.stringify(before)]),
    'memory covers undo, not any rewind an opponent fancies');
});

/* ---- purity and serialization (relied on by the future sync layer) ---- */

test('applyMove does not mutate the state it is given', () => {
  const state = withDice(place(emptyState(), 13, 'white', 1), 5);
  const before = JSON.stringify(state);
  applyMove(state, 'white', 13, 8);
  assertEqual(JSON.stringify(state), before, 'original state unchanged');
});

test('a rejected move leaves the state untouched', () => {
  let state = place(emptyState(), 13, 'white', 1);
  state = place(state, 8, 'black', 2);
  state = withDice(state, 5);

  const before = JSON.stringify(state);
  const result = applyMove(state, 'white', 13, 8);
  assert(!result.ok, 'move rejected');
  assertEqual(JSON.stringify(result.state), before, 'state unchanged');
});

test('state survives a JSON round trip unchanged', () => {
  const state = withDice(createInitialState(), 6, 4);
  const restored = JSON.parse(JSON.stringify(state));
  assertEqual(restored, state, 'round trip is lossless');
  assertEqual(pipCount(restored, 'white'), 167, 'rules still work on restored state');
});

test('no checker is ever lost across a sequence of moves', () => {
  let state = withDice(createInitialState(), 6, 5);
  state.currentPlayer = 'white';

  let result = applyMove(state, 'white', 24, 18);
  assert(result.ok, '24 -> 18');
  result = applyMove(result.state, 'white', 18, 13);
  assert(result.ok, '18 -> 13');

  assertEqual(totalCheckers(result.state, 'white'), 15, 'white still has 15');
  assertEqual(totalCheckers(result.state, 'black'), 15, 'black still has 15');
});

/* ---- sync.js: room joining and state propagation ----
 *
 * sync.js talks to Firebase through a tiny slice of its API - ref(path),
 * .transaction(), .on('value'), .off('value'), .set(), .update(),
 * .remove(), and the .info/connected + .onDisconnect() presence idiom -
 * injected via joinRoom's `database` option. These tests exercise that
 * same slice against a small in-memory fake rather than a real Firebase
 * project, so the suite stays fast and has no network dependency; it
 * deliberately does NOT re-test Firebase itself (that's Firebase's job),
 * only how sync.js uses it - seat assignment, initial-state seeding,
 * propagation, presence.
 *
 * The fake can't reproduce a *real* disconnect (that's detected server-side
 * by the actual Firebase backend, nothing a client-side fake can trigger);
 * what it can and does reproduce is the contract sync.js relies on -
 * onDisconnect() registers an action against a path, and _simulateDisconnect
 * runs whatever's registered there, standing in for the server noticing the
 * connection drop. That's enough to test sync.js's side of the idiom
 * without testing Firebase's delivery of it.
 *
 * The fake resolves every operation via setTimeout(0) rather than
 * synchronously, on purpose: it's what makes the concurrent-join test
 * below meaningful. Two transactions scheduled back to back on the same
 * tick still run in the order they were scheduled, each seeing the
 * previous one's committed result - the same guarantee a real Firebase
 * transaction gives two genuinely simultaneous devices, which is the
 * entire reason seat-claiming moved from Stage C's plain read-then-write
 * to a transaction in the first place.
 *
 * Multiple joinRoom calls sharing one fake database instance simulate
 * multiple real clients talking to the same Firebase project; each still
 * gets its own fake clientId via the third argument, standing in for
 * sessionStorage (genuinely per-tab, so it can't be faked from one page).
 * A fresh random room code per test keeps runs from colliding.
 */

function freshRoomCode() {
  return 'T' + Math.random().toString(36).slice(2, 5).toUpperCase();
}

/* Firebase never actually stores a null value, or an empty object/array -
   writing one just makes that key absent on the next read. Confirmed
   directly against the live database (see the sync.js commit for the
   curl transcripts), not assumed from documentation, because it's exactly
   the kind of thing a fake that only mirrors what you'd naively expect
   would fail to catch. Every write here goes through this so the fake
   actually exercises sync.js's serializeState/deserializeState, not just
   a JS object round trip that JSON.stringify would have handled for free. */
function stripNulls(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.length ? value : undefined;
  }
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((key) => {
      const cleaned = stripNulls(value[key]);
      if (cleaned !== undefined) {
        out[key] = cleaned;
      }
    });
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/* Firebase replaces a ServerValue sentinel with the server's own clock at
   write time. A fake that stored the sentinel object verbatim would let a
   test pass while the real database wrote something quite different - the
   same class of gap stripNulls exists to close. */
function resolveServerValues(value, serverTime) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value['.sv'] === 'timestamp') {
    return serverTime();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveServerValues(entry, serverTime));
  }
  const out = {};
  Object.keys(value).forEach((key) => {
    out[key] = resolveServerValues(value[key], serverTime);
  });
  return out;
}

/* The store is a real nested tree (not a flat map keyed by path string),
   because presence (rooms/<code>/presence/<color>) has to show up when
   something reads the room as a whole (rooms/<code>) - exactly like real
   Firebase, where a write anywhere in the tree is visible to a 'value'
   listener on any ancestor path. A flat map keyed by the literal path
   string a caller happened to use can't do that: a write to
   'rooms/ABC/presence/white' and a read of 'rooms/ABC' would be two
   unrelated entries, and the room's own listener would never see presence
   arrive - which is exactly the shape of bug this fake exists to catch. */
function createFakeDatabase() {
  const root = {};
  const listeners = {};
  const disconnectActions = {};

  function segments(path) {
    return path.split('/').filter(Boolean);
  }

  function getNode(path) {
    let node = root;
    for (const key of segments(path)) {
      if (node == null || typeof node !== 'object') {
        return undefined;
      }
      node = node[key];
    }
    return node;
  }

  /* Writes `value` at `path`, replacing whatever subtree was there, and
     prunes any ancestor left holding an empty object - matching Firebase,
     where an empty object isn't a value that exists. Does not notify;
     callers do that once, after every key of a multi-key write has landed,
     so a single set()/update() call produces exactly one 'value' event per
     listener, same as real Firebase. */
  function writeNode(path, value) {
    const parts = segments(path);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (typeof node[key] !== 'object' || node[key] === null) {
        node[key] = {};
      }
      node = node[key];
    }
    const leaf = parts[parts.length - 1];
    const cleaned = stripNulls(resolveServerValues(value, serverNow));
    if (cleaned === undefined) {
      delete node[leaf];
    } else {
      node[leaf] = cleaned;
    }
    for (let depth = parts.length - 1; depth >= 1; depth--) {
      let parent = root;
      for (let i = 0; i < depth - 1; i++) {
        parent = parent[parts[i]];
      }
      const key = parts[depth - 1];
      const child = parent ? parent[key] : undefined;
      if (child && typeof child === 'object' && Object.keys(child).length === 0) {
        delete parent[key];
      } else {
        break;
      }
    }
  }

  /* Fires every listener on `path` itself and on every ancestor of it -
     each gets the current value at *its own* path, not at the path that
     actually changed, same as a real Firebase 'value' listener. */
  function notify(path) {
    const parts = segments(path);
    for (let depth = parts.length; depth >= 0; depth--) {
      const ancestorPath = parts.slice(0, depth).join('/');
      const cbs = listeners[ancestorPath];
      if (!cbs) {
        continue;
      }
      const value = getNode(ancestorPath);
      cbs.forEach((cb) => setTimeout(() => cb({ val: () => (value === undefined ? null : value) }), 0));
    }
  }

  /* The clock the sentinel resolves against. Tests pin _serverTime to make
     "this came from the server, not the client" assertable: a pinned value
     is one no client-side Date.now() could have produced. */
  function serverNow() {
    return db._serverTime !== null ? db._serverTime : Date.now();
  }

  const db = {
    _serverTime: null,
    ref(path) {
      return {
        /* An update function returning undefined aborts the transaction,
           writing nothing - which is how a caller says "somebody beat me
           to this". The fake honoured neither half before the lobby
           needed it: it wrote undefined (deleting the node) and reported
           committed regardless, so a losing racer would have looked like
           a winner. */
        transaction(updateFn) {
          return new Promise((resolve) => {
            setTimeout(() => {
              const current = getNode(path) ?? null;

              /* Real Firebase runs the update function optimistically
                 against its local cache - usually empty - before it has the
                 server's value, and only then re-runs it with the truth.
                 A fake that hands over the real value on the first call
                 lets code pass here that cannot work against the live
                 database: a claim that aborted on a null first invocation
                 did exactly that, and took a live debugging session to
                 find. So the null pass is simulated whenever there is
                 actually something there, and its result discarded. */
              if (current !== null) {
                const optimistic = updateFn(null);
                /* An abort on the optimistic pass ends the transaction
                   there and then - Firebase does not go on to try the real
                   value. That is the whole trap: code which treats a null
                   first invocation as "already taken" never reaches the
                   server at all. */
                if (optimistic === undefined) {
                  resolve({ committed: false, snapshot: { val: () => current } });
                  return;
                }
              }

              const next = updateFn(current);
              if (next === undefined) {
                resolve({ committed: false, snapshot: { val: () => current } });
                return;
              }
              writeNode(path, next);
              notify(path);
              const committed = getNode(path) ?? null;
              resolve({ committed: true, snapshot: { val: () => committed } });
            }, 0);
          });
        },
        /* Resolves asynchronously like every other call here, so a caller
           that reads the lobby and then acts on it is still exposed to
           anything that happened in between - which is the whole point of
           the claim being a transaction. */
        once(event) {
          return new Promise((resolve) => {
            setTimeout(() => {
              const value = getNode(path);
              resolve({ val: () => (value === undefined ? null : value) });
            }, 0);
          });
        },
        on(event, cb) {
          if (event !== 'value') {
            return;
          }
          listeners[path] = listeners[path] || new Set();
          listeners[path].add(cb);
          /* .info/connected has no writer of its own in this fake - it's
             always "connected", resolved on a microtask (asynchronous, like
             every real Firebase call here, but without piling an extra
             setTimeout macrotask onto every single client join - with two
             or three joins per sync test across the whole suite, those add
             up enough to occasionally push a slower test past its waitFor
             budget). */
          if (path === '.info/connected') {
            Promise.resolve().then(() => cb({ val: () => true }));
            return;
          }
          const value = getNode(path);
          setTimeout(() => cb({ val: () => (value === undefined ? null : value) }), 0);
        },
        off(event, cb) {
          if (listeners[path]) {
            listeners[path].delete(cb);
          }
        },
        set(value) {
          writeNode(path, value);
          notify(path);
          return Promise.resolve();
        },
        /* Merges only the given top-level keys into whatever's already at
           `path`, leaving sibling keys (like a presence entry written by a
           different client) untouched - unlike set(), which would replace
           the whole node. */
        update(patch) {
          Object.keys(patch).forEach((key) => {
            writeNode(path + '/' + key, patch[key]);
          });
          notify(path);
          return Promise.resolve();
        },
        remove() {
          writeNode(path, undefined);
          notify(path);
          return Promise.resolve();
        },
        /* Registers an action for _simulateDisconnect to run later, standing
           in for the server-side registration a real onDisconnect() makes.
           Resolved on a microtask (sync.js chains a .then() off of it) -
           see the .info/connected comment above for why not setTimeout. */
        onDisconnect() {
          return {
            remove() {
              return Promise.resolve().then(() => {
                disconnectActions[path] = { type: 'remove' };
              });
            },
            set(value) {
              return Promise.resolve().then(() => {
                disconnectActions[path] = { type: 'set', value };
              });
            },
            /* Withdraws a registered action, for when a client tidies up
               deliberately rather than by vanishing. */
            cancel() {
              delete disconnectActions[path];
              return Promise.resolve();
            },
          };
        },
      };
    },
    /* Test-only: runs whatever onDisconnect() action is registered at
       `path`, standing in for the real Firebase server noticing this
       client's connection drop. */
    _simulateDisconnect(path) {
      const action = disconnectActions[path];
      if (!action) {
        return;
      }
      writeNode(path, action.type === 'remove' ? undefined : action.value);
      delete disconnectActions[path];
      notify(path);
    },
  };

  return db;
}

test('the first client to join an empty room is seated white', async () => {
  const db = createFakeDatabase();
  let color = null;
  const a = joinRoom(freshRoomCode(), { onRoom: () => { color = a.color; } }, { clientId: 'c1', database: db });
  await waitFor(() => color !== null);
  assertEqual(color, 'white');
});

test('a second, different client is seated black', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let aColor = null;
  let bColor = null;
  const a = joinRoom(code, { onRoom: () => { aColor = a.color; } }, { clientId: 'c1', database: db });
  await waitFor(() => aColor !== null);
  const b = joinRoom(code, { onRoom: () => { bColor = b.color; } }, { clientId: 'c2', database: db });
  await waitFor(() => bColor !== null);
  assertEqual(aColor, 'white');
  assertEqual(bColor, 'black');
});

test('a third client becomes a spectator once both seats are taken', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let cColor = null;
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');
  const c = joinRoom(code, { onRoom: () => { cColor = c.color; } }, { clientId: 'c3', database: db });
  await waitFor(() => cColor !== null);
  assertEqual(cColor, 'spectator');
});

test('rejoining with the same client id reclaims the same seat', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a1 = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a1.color !== 'spectator');
  a1.leave();

  let color = null;
  const a2 = joinRoom(code, { onRoom: () => { color = a2.color; } }, { clientId: 'c1', database: db });
  await waitFor(() => color !== null);
  assertEqual(color, 'white', 'same id reclaims white rather than falling through to black');
});

/* This is the concurrency guarantee that motivated switching seat-claiming
   from Stage C's plain read-then-write to a Firebase transaction: two
   clients whose joins race - both starting before either has committed -
   must still end up on different seats, never both landing on white. */
test('two clients joining at the same instant still get distinct seats', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let aColor = null;
  let bColor = null;
  const a = joinRoom(code, { onRoom: () => { aColor = a.color; } }, { clientId: 'c1', database: db });
  const b = joinRoom(code, { onRoom: () => { bColor = b.color; } }, { clientId: 'c2', database: db });
  await waitFor(() => aColor !== null && bColor !== null);
  assert(new Set([aColor, bColor]).size === 2, `expected distinct seats, got ${aColor} and ${bColor}`);
});

test('a state sent by one client is delivered to another', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');

  let received = null;
  const b = joinRoom(code, { onRoom: (room) => { received = room; } }, { clientId: 'c2', database: db });
  await waitFor(() => received !== null);
  received = null;

  a.sendState(withRoll(createInitialState(), [4, 2]));
  await waitFor(() => received && received.seq >= 1);

  assertEqual(received.state.dice.map((d) => d.value), [4, 2], 'the roll reached the other client');
});

test('a client joining after moves have been made sees the current state, not the start', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let aRoom = null;
  const a = joinRoom(code, { onRoom: (room) => { aRoom = room; } }, { clientId: 'c1', database: db });
  await waitFor(() => aRoom !== null);

  /* withRoll materializes whatever array it's given as-is; the doubles ->
     four-dice expansion happens in rollValues, not withRoll, so a mocked
     random is needed to actually get four dice here rather than two. */
  a.sendState(withRoll(createInitialState(), rollValues(() => 0.99)));
  await waitFor(() => aRoom.state && aRoom.state.dice.length === 4);

  let bRoom = null;
  joinRoom(code, { onRoom: (room) => { bRoom = room; } }, { clientId: 'c2', database: db });
  await waitFor(() => bRoom !== null);

  assertEqual(bRoom.state.dice.length, 4, 'late joiner sees the doubles already on the board');
});

/* ---- sync.js: presence ---- */

test('a seated client is marked present in the room', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room && room.presence && room.presence.white === true);
});

test('a spectator gets no presence entry of their own', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');

  let cRoom = null;
  const c = joinRoom(code, { onRoom: (r) => { cRoom = r; } }, { clientId: 'c3', database: db });
  await waitFor(() => c.color === 'spectator' && cRoom && cRoom.presence);

  assert(!('spectator' in cRoom.presence), 'no presence key should exist for a spectator');
});

test('a client\'s presence is cleared once it disconnects', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');

  let bRoom = null;
  joinRoom(code, { onRoom: (r) => { bRoom = r; } }, { clientId: 'c2', database: db });
  await waitFor(() => bRoom && bRoom.presence && bRoom.presence.white === true);

  db._simulateDisconnect(`rooms/${code}/presence/white`);
  await waitFor(() => !bRoom.presence || !bRoom.presence.white);
});

test('sending a state update does not clobber the other seat\'s presence', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');

  let bRoom = null;
  const b = joinRoom(code, { onRoom: (r) => { bRoom = r; } }, { clientId: 'c2', database: db });
  await waitFor(() => bRoom && bRoom.presence && bRoom.presence.white === true && bRoom.presence.black === true);

  bRoom = null;
  a.sendState(withRoll(createInitialState(), [3, 4]));
  await waitFor(() => bRoom && bRoom.seq >= 1);

  assertEqual(bRoom.presence.black, true, "black's own presence should survive white sending a state update");
});

/* ---- sync.js: seat recovery after a discarded tab (stage 5a) ----
 *
 * A tab's identity lives in sessionStorage (identityFor), which is what
 * lets two tabs on one machine hold both seats - but mobile browsers
 * discard a backgrounded tab along with its sessionStorage. The tab that
 * comes back a day later rejoins under a brand new id, finds both seats
 * still held (a seat is never freed), and is demoted to spectator, which
 * blockedOnline() then blocks out of the game entirely. That is the bug
 * these tests describe.
 *
 * The fix under test: mirror the id to localStorage as well, and when a
 * join finds sessionStorage empty, offer the mirrored id to the
 * seat-claiming transaction as a *candidate* - adopted only if that seat
 * has no presence entry right now. Presence is what separates the two
 * cases that otherwise look identical from the room record alone: a
 * player returning to a seat nobody is sitting in (reclaim it) versus a
 * second tab opening alongside a live one (do not steal it).
 *
 * These go through joinRoom's `recoveredClientId` option, the same kind of
 * seam `clientId` already is - real callers get it from localStorage,
 * tests inject it, because per-tab storage can't be faked from one page.
 */

test('a returning client whose tab was discarded reclaims its seat instead of spectating', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');

  /* The tab is discarded: the server notices the connection drop and
     clears presence, but the seat itself stays claimed, as designed. */
  db._simulateDisconnect(`rooms/${code}/presence/white`);
  a.leave();

  let color = null;
  const returning = joinRoom(
    code,
    { onRoom: () => { color = returning.color; } },
    { clientId: 'c1-new-tab', recoveredClientId: 'c1', database: db }
  );
  await waitFor(() => color !== null);
  assertEqual(color, 'white', 'the returning player should get their own seat back, not spectate their own game');
});

test('a second tab on the same machine does not steal a seat that is still occupied', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let aRoom = null;
  const a = joinRoom(code, { onRoom: (r) => { aRoom = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => aRoom && aRoom.presence && aRoom.presence.white === true);

  /* localStorage is shared across every tab of one origin, so a genuinely
     new second tab really does find the first tab's mirrored id. It must
     not be adopted here: the first tab is still sitting in that seat. */
  let color = null;
  const second = joinRoom(
    code,
    { onRoom: () => { color = second.color; } },
    { clientId: 'c2', recoveredClientId: 'c1', database: db }
  );
  await waitFor(() => color !== null);
  assertEqual(color, 'black', 'a live seat should never be handed to a second tab, only an abandoned one');
  assertEqual(a.color, 'white', 'and the tab actually holding the seat should keep it');
});

test('a recovery candidate that holds no seat is ignored', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');

  let color = null;
  const c = joinRoom(
    code,
    { onRoom: () => { color = c.color; } },
    { clientId: 'c3', recoveredClientId: 'never-sat-here', database: db }
  );
  await waitFor(() => color !== null);
  assertEqual(color, 'spectator', 'a stale candidate must not become a way to take a seat off someone');
});

test('both players returning to an abandoned room reclaim their own seats', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');

  db._simulateDisconnect(`rooms/${code}/presence/white`);
  db._simulateDisconnect(`rooms/${code}/presence/black`);
  a.leave();
  b.leave();

  let aColor = null;
  let bColor = null;
  const a2 = joinRoom(code, { onRoom: () => { aColor = a2.color; } }, { clientId: 'c1-new', recoveredClientId: 'c1', database: db });
  await waitFor(() => aColor !== null);
  const b2 = joinRoom(code, { onRoom: () => { bColor = b2.color; } }, { clientId: 'c2-new', recoveredClientId: 'c2', database: db });
  await waitFor(() => bColor !== null);

  assertEqual(aColor, 'white', 'white should come back to white');
  assertEqual(bColor, 'black', 'black should come back to black');
});

test('reclaiming a seat leaves the other seat untouched', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');

  db._simulateDisconnect(`rooms/${code}/presence/white`);
  a.leave();

  let room = null;
  joinRoom(
    code,
    { onRoom: (r) => { room = r; } },
    { clientId: 'c1-new-tab', recoveredClientId: 'c1', database: db }
  );
  await waitFor(() => room !== null);
  assertEqual(room.seats.black, 'c2', "black's seat should be exactly as it was before white came back");
});

test('a reclaimed seat sees the game already in progress, not a fresh board', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let aRoom = null;
  const a = joinRoom(code, { onRoom: (r) => { aRoom = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => aRoom !== null);
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');

  a.sendState(withRoll(createInitialState(), [5, 3]));
  await waitFor(() => aRoom.state && aRoom.state.dice.length === 2);

  db._simulateDisconnect(`rooms/${code}/presence/white`);
  a.leave();

  let room = null;
  joinRoom(
    code,
    { onRoom: (r) => { room = r; } },
    { clientId: 'c1-new-tab', recoveredClientId: 'c1', database: db }
  );
  await waitFor(() => room && room.state);
  assertEqual(room.state.dice.map((d) => d.value), [5, 3], 'the game should resume where it was left, not restart');
});

test('a reclaimed seat is marked present again', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');

  let bRoom = null;
  joinRoom(code, { onRoom: (r) => { bRoom = r; } }, { clientId: 'c2', database: db });
  await waitFor(() => bRoom && bRoom.presence && bRoom.presence.white === true);

  db._simulateDisconnect(`rooms/${code}/presence/white`);
  a.leave();
  await waitFor(() => !bRoom.presence || !bRoom.presence.white);

  joinRoom(
    code,
    { onRoom: () => {} },
    { clientId: 'c1-new-tab', recoveredClientId: 'c1', database: db }
  );
  await waitFor(() => bRoom.presence && bRoom.presence.white === true);
});

/* ---- sync.js: the stored identity behind seat recovery ----
 *
 * The half of stage 5a above the transaction: which id a join actually
 * arrives with, and which one it offers as a recovery candidate. Reading
 * the mirror has to happen *before* sessionStorage is written, or
 * sessionStorage is never empty and the candidate is never offered -
 * which is why this is one function returning both rather than two that
 * have to be called in the right order.
 */

test('a fresh tab records its client id in both session and local storage', () => {
  const code = freshRoomCode();
  const identity = identityFor(code);

  assertEqual(sessionStorage.getItem(CLIENT_ID_PREFIX + code), identity.clientId, 'the per-tab identity is still sessionStorage');
  assertEqual(localStorage.getItem(RECOVERY_ID_PREFIX + code), identity.clientId, 'and it is mirrored for a future tab to recover');
  assertEqual(identity.recoveredClientId, null, 'a room this browser has never seen has nothing to recover');
});

test('a tab that still holds its session identity offers no recovery candidate', () => {
  const code = freshRoomCode();
  const first = identityFor(code);
  const again = identityFor(code);

  assertEqual(again.clientId, first.clientId, 'a reload of the same tab keeps the same id, exactly as before');
  assertEqual(again.recoveredClientId, null, 'nothing to recover while the session identity is intact');
});

test('a tab whose session storage was discarded offers the mirrored id as a candidate', () => {
  const code = freshRoomCode();
  const first = identityFor(code);

  /* What a mobile browser does to a backgrounded tab: sessionStorage goes,
     localStorage stays. */
  sessionStorage.removeItem(CLIENT_ID_PREFIX + code);

  const returning = identityFor(code);
  assert(returning.clientId !== first.clientId, 'the new tab is genuinely a new client, not the old one');
  assertEqual(returning.recoveredClientId, first.clientId, 'and it carries the old id as the seat it means to reclaim');
});

test('a recovery candidate is scoped to its own room', () => {
  const roomA = freshRoomCode();
  const roomB = freshRoomCode();
  const a = identityFor(roomA);
  const b = identityFor(roomB);

  sessionStorage.removeItem(CLIENT_ID_PREFIX + roomB);
  const returning = identityFor(roomB);

  assertEqual(returning.recoveredClientId, b.clientId, 'room B recovers room B');
  assert(returning.recoveredClientId !== a.clientId, 'and never room A, which may still be live in another tab');
});

/* ---- sync.js: the last room joined (stage 5d) ----
 *
 * What the start screen's Rejoin button is built on. Deliberately one
 * value rather than one per room: "the room I was in" is singular, and a
 * list would be a history feature nobody asked for.
 */

test('the most recent room joined is the one remembered', () => {
  const first = freshRoomCode();
  const second = freshRoomCode();

  rememberRoom(first);
  assertEqual(lastRoomCode(), first, 'a room joined is remembered');

  rememberRoom(second);
  assertEqual(lastRoomCode(), second, 'and a later room replaces it rather than adding to a list');
});

test('remembering a room does not disturb a seat identity', () => {
  const code = freshRoomCode();
  const identity = identityFor(code);

  rememberRoom(code);

  assertEqual(localStorage.getItem(RECOVERY_ID_PREFIX + code), identity.clientId, 'the seat mirror is untouched');
  assertEqual(sessionStorage.getItem(CLIENT_ID_PREFIX + code), identity.clientId, 'and so is the per-tab identity');
  assertEqual(lastRoomCode(), code, 'while the last-room value is its own separate key');
});

/* ---- sync.js: leaving on purpose vs. losing the connection (stage 5c) ----
 *
 * Both end with the same presence entry gone, so the room record alone
 * can't tell them apart - and "opponent disconnected" is the wrong thing
 * to tell someone whose opponent has actually quit and isn't coming back.
 * leave({ departed: true }) is what separates them; the plain disconnect
 * path must be careful *not* to set it.
 */

test('leaving on purpose marks that seat as departed', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');

  let bRoom = null;
  joinRoom(code, { onRoom: (r) => { bRoom = r; } }, { clientId: 'c2', database: db });
  await waitFor(() => bRoom && bRoom.presence && bRoom.presence.white === true);

  a.leave({ departed: true });
  await waitFor(() => bRoom.departed && bRoom.departed.white === true);
  await waitFor(() => !bRoom.presence || !bRoom.presence.white);
});

test('an ordinary disconnect does not mark the seat as departed', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');

  let bRoom = null;
  joinRoom(code, { onRoom: (r) => { bRoom = r; } }, { clientId: 'c2', database: db });
  await waitFor(() => bRoom && bRoom.presence && bRoom.presence.white === true);

  /* The server noticing a dropped connection - a closed tab, a dead
     network - which clears presence and nothing else. */
  db._simulateDisconnect(`rooms/${code}/presence/white`);
  await waitFor(() => !bRoom.presence || !bRoom.presence.white);

  assert(!(bRoom.departed && bRoom.departed.white), 'a dropped connection is not someone quitting, and must not read as one');
});

test('leaving without announcing it does not mark the seat as departed', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');

  let bRoom = null;
  joinRoom(code, { onRoom: (r) => { bRoom = r; } }, { clientId: 'c2', database: db });
  await waitFor(() => bRoom && bRoom.presence && bRoom.presence.white === true);

  a.leave();
  await waitFor(() => !bRoom.presence || !bRoom.presence.white);

  assert(!(bRoom.departed && bRoom.departed.white), 'leave() on its own is the teardown path, not a quit announcement');
});

test('coming back to a seat clears the departed flag it left behind', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');

  let bRoom = null;
  joinRoom(code, { onRoom: (r) => { bRoom = r; } }, { clientId: 'c2', database: db });
  await waitFor(() => bRoom && bRoom.presence && bRoom.presence.white === true);

  a.leave({ departed: true });
  await waitFor(() => bRoom.departed && bRoom.departed.white === true);

  /* Same tab, same client id - the reload case, which reclaims the seat. */
  joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => !bRoom.departed || !bRoom.departed.white);
  await waitFor(() => bRoom.presence && bRoom.presence.white === true);
});

test('a spectator leaving announces nothing, having no seat to leave', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1', database: db });
  await waitFor(() => a.color !== 'spectator');
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');

  let room = null;
  const c = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c3', database: db });
  await waitFor(() => c.color === 'spectator' && room !== null);

  c.leave({ departed: true });
  await waitFor(() => true);
  assert(!room.departed, 'a spectator has no seat, so there is nobody waiting on one to announce to');
});

/* ---- sync.js: lastActive, for telling stale rooms apart ----
 *
 * Nothing deletes rooms - database.rules.json grants access only to a room
 * whose code you already know, there is no listing, and no client has any
 * business removing someone else's room. What this buys is the ability to
 * *identify* dead rooms, from the Firebase console today and from a
 * scheduled job later.
 */

test('a room nobody has played carries no lastActive at all', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  assert(room.lastActive === undefined, 'joining is not activity - an unplayed room should be recognisable as never having been a game');
});

test('sending state records lastActive as a resolved number', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  a.sendState(createInitialState());
  await waitFor(() => room.lastActive !== undefined);

  assertEqual(typeof room.lastActive, 'number', 'the sentinel must arrive resolved, not stored as a { ".sv": "timestamp" } object');
});

test('lastActive comes from the server clock, not the client', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  /* A value no client-side Date.now() could produce. If this ever gets
     "simplified" to a local clock, this is the test that fails - and it
     matters, because a device with a wrong clock would otherwise make a
     dead room look fresh or bury a live one. */
  db._serverTime = 4242;

  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  a.sendState(createInitialState());
  await waitFor(() => room.lastActive !== undefined);

  assertEqual(room.lastActive, 4242, 'written through the server-timestamp sentinel');
});

test('a later move advances lastActive', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  db._serverTime = 1000;

  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  a.sendState(createInitialState());
  await waitFor(() => room.lastActive === 1000);

  db._serverTime = 2000;
  a.sendState(withRoll(createInitialState(), [3, 5]));
  await waitFor(() => room.lastActive === 2000);
});

test('recording lastActive leaves presence, seats and departed alone', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  /* Observed through `a`, the client that stays: leave() detaches the
     leaver's own listener, so watching through `b` would go blind at
     exactly the moment this test cares about. */
  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2', database: db });
  await waitFor(() => b.color !== 'spectator');
  await waitFor(() => room.presence && room.presence.white === true && room.presence.black === true);

  /* Give black a departed flag to defend too, so the update() carrying
     lastActive has every other key of the record to step on. */
  b.leave({ departed: true });
  await waitFor(() => room.departed && room.departed.black === true);

  a.sendState(withRoll(createInitialState(), [2, 4]));
  await waitFor(() => room.lastActive !== undefined);

  assertEqual(room.presence.white, true, "white's own presence survives its own write");
  assertEqual(room.departed.black, true, "black's departure is not erased by white moving");
  assertEqual(room.seats.white, 'c1', 'seats are untouched');
  assertEqual(room.seats.black, 'c2', 'both of them');
});

/* ---- sync.js: the lobby (stage 7b) ----
 *
 * Advertises rooms wanting a second player, rather than players wanting
 * games. The searcher who arrives second does all the matching; the one
 * who advertised just sits in their room, where a claimed advertisement
 * and a texted invite link are indistinguishable by the time they matter.
 */

/* Every fake operation resolves on a later tick, deliberately - so a test
   must wait for the lobby to actually reflect a write rather than assume
   it has landed. `waitFor(async () => true)` does not do that: a Promise
   is truthy, so such a condition passes on its first poll having waited
   for nothing. This watches the real list instead. */
function lobbyWatcher(db) {
  const watcher = { count: -1 };
  watcher.detach = watchLobbyCount((n) => { watcher.count = n; }, { database: db });
  return watcher;
}

test('a room with nobody waiting has nothing to claim', async () => {
  const db = createFakeDatabase();
  const claimed = await claimWaitingRoom({ database: db });
  assertEqual(claimed, null, 'an empty lobby returns nothing rather than hanging or throwing');
});

test('an advertised room can be claimed by someone else', async () => {
  const db = createFakeDatabase();
  const code = freshRoomCode();
  const watcher = lobbyWatcher(db);
  advertiseRoom(code, { clientId: 'adv1', database: db });
  await waitFor(() => watcher.count === 1);

  const claimed = await claimWaitingRoom({ skipEntryId: 'other', database: db });
  assertEqual(claimed, code, 'the claimer is told which room to join');
});

test('claiming removes the advertisement, so nobody else takes the same room', async () => {
  const db = createFakeDatabase();
  const watcher = lobbyWatcher(db);
  advertiseRoom(freshRoomCode(), { clientId: 'adv1', database: db });
  await waitFor(() => watcher.count === 1);

  const first = await claimWaitingRoom({ skipEntryId: 'x', database: db });
  const second = await claimWaitingRoom({ skipEntryId: 'y', database: db });

  assert(first !== null, 'the first claim succeeds');
  assertEqual(second, null, 'and leaves nothing behind for the second');
});

/* The concurrency guarantee the transaction exists for, one level up from
   claimSeat's: two searchers arriving at the same instant must not both
   believe they got the same room, or they would join it as White's
   opponent and a spectator.

   Honest limitation, established by mutation-testing this: replacing the
   transaction with a plain read-then-delete still passes. The fake's set()
   and remove() write synchronously inside the caller's own callback, so a
   read and its following write can never be interleaved by another client
   the way a real network round trip allows. That makes read-then-write
   effectively atomic here, and this test therefore documents intent rather
   than proving the guarantee - as does the older seat-claim equivalent it
   is modelled on. Proving it would mean making the fake's writes resolve
   asynchronously, which is a change to every test in this file. The
   transaction stays because it is what real Firebase requires; do not
   "simplify" it on the strength of this test passing without one. */
test('two searchers claiming at the same instant cannot get the same room', async () => {
  const db = createFakeDatabase();
  const code = freshRoomCode();
  const watcher = lobbyWatcher(db);
  advertiseRoom(code, { clientId: 'adv1', database: db });
  await waitFor(() => watcher.count === 1);

  const [a, b] = await Promise.all([
    claimWaitingRoom({ skipEntryId: 'x', database: db }),
    claimWaitingRoom({ skipEntryId: 'y', database: db }),
  ]);

  const winners = [a, b].filter((room) => room !== null);
  assertEqual(winners.length, 1, `exactly one searcher may win, got ${JSON.stringify([a, b])}`);
  assertEqual(winners[0], code);
});

test('a searcher never claims its own advertisement', async () => {
  const db = createFakeDatabase();
  const watcher = lobbyWatcher(db);
  advertiseRoom(freshRoomCode(), { clientId: 'mine', database: db });
  await waitFor(() => watcher.count === 1);

  const claimed = await claimWaitingRoom({ skipEntryId: 'mine', database: db });
  assertEqual(claimed, null, 'matching yourself would seat you in your own room as both players');
});

test('the longest-waiting room is matched first', async () => {
  const db = createFakeDatabase();
  const older = freshRoomCode();
  const newer = freshRoomCode();

  const watcher = lobbyWatcher(db);
  db._serverTime = 1000;
  advertiseRoom(older, { clientId: 'adv-old', database: db });
  await waitFor(() => watcher.count === 1);
  db._serverTime = 2000;
  advertiseRoom(newer, { clientId: 'adv-new', database: db });
  await waitFor(() => watcher.count === 2);

  const claimed = await claimWaitingRoom({ skipEntryId: 'x', database: db });
  assertEqual(claimed, older, 'whoever has waited longest is matched first, not whoever sorts earliest by id');
});

test('withdrawing an advertisement takes the room off the list', async () => {
  const db = createFakeDatabase();
  const watcher = lobbyWatcher(db);
  const ad = advertiseRoom(freshRoomCode(), { clientId: 'adv1', database: db });
  await waitFor(() => watcher.count === 1);

  ad.stop();
  await waitFor(() => watcher.count === 0);

  const claimed = await claimWaitingRoom({ skipEntryId: 'x', database: db });
  assertEqual(claimed, null, 'a room that filled up or was left must not stay advertised');
});

test('a dropped connection takes the advertisement with it', async () => {
  const db = createFakeDatabase();
  const watcher = lobbyWatcher(db);
  advertiseRoom(freshRoomCode(), { clientId: 'adv1', database: db });
  await waitFor(() => watcher.count === 1);

  /* A closed tab, not a deliberate withdrawal - the same onDisconnect
     idiom presence uses, for the same reason. */
  db._simulateDisconnect(`${LOBBY_PATH}/adv1`);
  await waitFor(() => watcher.count === 0);

  const claimed = await claimWaitingRoom({ skipEntryId: 'x', database: db });
  assertEqual(claimed, null, 'nobody should be sent to a room whose advertiser has vanished');
});

test('the waiting count excludes your own advertisement', async () => {
  const db = createFakeDatabase();
  let mine = -1;
  let theirs = -1;
  watchLobbyCount((n) => { mine = n; }, { skipEntryId: 'me', database: db });
  watchLobbyCount((n) => { theirs = n; }, { skipEntryId: 'someone-else', database: db });

  advertiseRoom(freshRoomCode(), { clientId: 'me', database: db });
  await waitFor(() => theirs === 1);

  assertEqual(mine, 0, 'the screen must be able to say "nobody else is looking" while you are the one waiting');
  assertEqual(theirs, 1, 'while another client sees you');
});

test('the first searcher starts a room and advertises it', async () => {
  const db = createFakeDatabase();
  const watcher = lobbyWatcher(db);

  const first = await findOrStartRoom({ clientId: 'p1', database: db });
  await waitFor(() => watcher.count === 1);

  assert(/^[A-Z0-9]{6}$/.test(first.roomCode), `a fresh room code, got ${first.roomCode}`);
  assert(first.advertisement !== null, 'and it is on the list, waiting to be claimed');
});

/* The feature, in one assertion: two people who each press "play online"
   end up in the same room instead of two empty ones. */
test('the second searcher lands in the first one\'s room', async () => {
  const db = createFakeDatabase();
  const watcher = lobbyWatcher(db);

  const first = await findOrStartRoom({ clientId: 'p1', database: db });
  await waitFor(() => watcher.count === 1);

  const second = await findOrStartRoom({ clientId: 'p2', database: db });

  assertEqual(second.roomCode, first.roomCode, 'both searchers must arrive at the same room');
  assertEqual(second.advertisement, null, 'and the claimer advertises nothing - the room it just joined is about to be full');
  await waitFor(() => watcher.count === 0, 800);
});

test('a third searcher, with the first two paired off, starts its own room', async () => {
  const db = createFakeDatabase();
  const watcher = lobbyWatcher(db);

  const first = await findOrStartRoom({ clientId: 'p1', database: db });
  await waitFor(() => watcher.count === 1);
  await findOrStartRoom({ clientId: 'p2', database: db });
  await waitFor(() => watcher.count === 0, 800);

  const third = await findOrStartRoom({ clientId: 'p3', database: db });

  assert(third.roomCode !== first.roomCode, 'it must not be sent into a room that already has two players');
  assert(third.advertisement !== null, 'it waits, in turn');
});

/* ---- serializeState / deserializeState: Firebase's null-stripping ----
 *
 * These exist because two real bugs slipped past every test above: room.state
 * checked with `=== null` to detect a fresh room, which broke the moment a
 * real Firebase-backed room came back with `state` merely absent rather than
 * null; and rules.js's 25-slot points array, being mostly null, doesn't
 * survive a Firebase round trip as an array at all - confirmed against the
 * live database, not assumed. Both were invisible to the local-only Stage C
 * tests and to any fake that just mirrors a plain JS object, which is why
 * createFakeDatabase now specifically strips nulls/empties (see stripNulls)
 * rather than only proving sync.js's own logic against a faithful copy of
 * whatever it wrote.
 */

test('a fresh room has no state, and deserializeState leaves that as something falsy rather than crashing', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);
  assert(room.state == null, 'a fresh room\'s state should read as absent, matching what script.js checks for');
});

test('an empty dice array survives a full send/receive round trip', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  a.sendState(endTurn(withRoll(createInitialState(), [3, 4])));
  await waitFor(() => room.state);

  assertEqual(room.state.dice, [], 'dice should round-trip as an empty array, not go missing or throw');
});

test('a sparse points array (most points empty) survives a full send/receive round trip', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  const sent = createInitialState();
  a.sendState(sent);
  await waitFor(() => room.state);

  assertEqual(room.state, sent, 'a full game state should be byte-for-byte identical after the round trip');
  assertEqual(pipCount(room.state, 'white'), 167, 'and the rules should work on what comes back, not just look equal');
});

test('a fresh opening state survives a round trip, nulls and all', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  /* The sharpest case of Firebase's null-stripping in this codebase: an
     untouched opening roll is { white: null, black: null }, which is
     stored as nothing at all - the key is simply absent on read. */
  a.sendState(createInitialState());
  await waitFor(() => room.state);

  assertEqual(room.state.phase, 'opening', 'the phase must survive, or both players get sent back to roll');
  assertEqual(room.state.openingRoll, { white: null, black: null }, 'and both keys must come back, not vanish with their nulls');
  assertEqual(room.state.dice, []);
});

test('half a finished opening round survives a round trip', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  a.sendState(rollOpeningDie(createInitialState(), 'white', () => 0.95)); // white 6, black not yet
  await waitFor(() => room.state && room.state.openingRoll);

  assertEqual(room.state.openingRoll, { white: 6, black: null }, "black's absent key must read back as not-yet-rolled");
  assertEqual(room.state.phase, 'opening');
});

test('a resolved opening survives a round trip with its banner intact', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  let started = rollOpeningDie(createInitialState(), 'white', () => 0.25); // 2
  started = rollOpeningDie(started, 'black', () => 0.75); // 5
  a.sendState(started);
  await waitFor(() => room.state && room.state.phase === 'playing');

  assertEqual(room.state.currentPlayer, 'black');
  assertEqual(room.state.dice.map((d) => d.value), [2, 5]);
  assertEqual(room.state.openingRoll, { white: 2, black: 5 }, 'the banner values ride along as ordinary numbers');
});

test('an empty board (every checker borne off) survives a full send/receive round trip', async () => {
  const code = freshRoomCode();
  const db = createFakeDatabase();
  let room = null;
  const a = joinRoom(code, { onRoom: (r) => { room = r; } }, { clientId: 'c1', database: db });
  await waitFor(() => room !== null);

  const emptyBoard = { points: new Array(25).fill(null), bar: { white: 0, black: 0 }, off: { white: 15, black: 15 }, dice: [], currentPlayer: 'white', winner: null };
  a.sendState(emptyBoard);
  await waitFor(() => room.state);

  assertEqual(room.state.points, emptyBoard.points, 'an all-null points array should round-trip as all-null, not vanish or shrink');
});

/* ---- run everything and report ---- */

async function run() {
  const results = [];
  for (const { name, fn } of registeredTests) {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, message: error.message });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  window.__testResults = { passed, failed, total: results.length, results };

  const output = document.querySelector('#results');
  output.innerHTML =
    `<p class="${failed ? 'fail' : 'pass'}"><strong>${passed}/${results.length} passed</strong>` +
    (failed ? ` &mdash; ${failed} failed` : '') +
    '</p>' +
    results
      .map(
        (r) =>
          `<div class="${r.passed ? 'pass' : 'fail'}">${r.passed ? '✓' : '✗'} ${r.name}` +
          (r.passed ? '' : `<br><span class="msg">${r.message}</span>`) +
          '</div>'
      )
      .join('');
}

run();
