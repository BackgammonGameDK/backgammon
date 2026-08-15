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

test('white moves first', () => {
  assertEqual(createInitialState().currentPlayer, 'white');
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
  const next = endTurn(state);
  assertEqual(next.currentPlayer, 'black', 'switched to black');
  assertEqual(next.dice, [], 'dice cleared');
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

  let result = applyMove(state, 'white', 24, 18);
  assert(result.ok, '24 -> 18');
  result = applyMove(result.state, 'white', 18, 13);
  assert(result.ok, '18 -> 13');

  assertEqual(totalCheckers(result.state, 'white'), 15, 'white still has 15');
  assertEqual(totalCheckers(result.state, 'black'), 15, 'black still has 15');
});

/* ---- sync.js: room joining and state propagation ----
 *
 * Simulates two (or three) tabs from within one test page: each joinRoom
 * call gets its own BroadcastChannel instance, which is exactly what a real
 * second tab would have, and gets a fake clientId via the third argument
 * (real callers derive theirs from sessionStorage, which is genuinely
 * per-tab and can't be faked from a single page - see sync.js). A fresh
 * random room code per test keeps runs from colliding with each other or
 * with a real game in progress.
 */

function freshRoomCode() {
  return 'T' + Math.random().toString(36).slice(2, 5).toUpperCase();
}

test('the first client to join an empty room is seated white', () => {
  const a = joinRoom(freshRoomCode(), { onRoom: () => {} }, { clientId: 'c1' });
  assertEqual(a.color, 'white');
  a.leave();
});

test('a second, different client is seated black', () => {
  const code = freshRoomCode();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1' });
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2' });
  assertEqual(a.color, 'white');
  assertEqual(b.color, 'black');
  a.leave();
  b.leave();
});

test('a third client becomes a spectator once both seats are taken', () => {
  const code = freshRoomCode();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1' });
  const b = joinRoom(code, { onRoom: () => {} }, { clientId: 'c2' });
  const c = joinRoom(code, { onRoom: () => {} }, { clientId: 'c3' });
  assertEqual(c.color, 'spectator');
  a.leave();
  b.leave();
  c.leave();
});

test('rejoining with the same client id reclaims the same seat', () => {
  const code = freshRoomCode();
  const a1 = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1' });
  a1.leave();
  const a2 = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1' });
  assertEqual(a2.color, 'white', 'same id reclaims white rather than falling through to black');
  a2.leave();
});

test('a state sent by one client is delivered to another', async () => {
  const code = freshRoomCode();
  let received = null;
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1' });
  const b = joinRoom(code, { onRoom: (room) => { received = room; } }, { clientId: 'c2' });

  a.sendState(withRoll(createInitialState(), [4, 2]));
  await waitFor(() => received && received.seq >= 1);

  assertEqual(received.state.dice.map((d) => d.value), [4, 2], 'the roll reached the other client');
  a.leave();
  b.leave();
});

test('a client joining after moves have been made sees the current state, not the start', async () => {
  const code = freshRoomCode();
  const a = joinRoom(code, { onRoom: () => {} }, { clientId: 'c1' });
  /* withRoll materializes whatever array it's given as-is; the doubles ->
     four-dice expansion happens in rollValues, not withRoll, so a mocked
     random is needed to actually get four dice here rather than two. */
  a.sendState(withRoll(createInitialState(), rollValues(() => 0.99)));

  let received = null;
  const b = joinRoom(code, { onRoom: (room) => { received = room; } }, { clientId: 'c2' });
  await waitFor(() => received !== null);

  assertEqual(received.state.dice.length, 4, 'late joiner sees the doubles already on the board');
  a.leave();
  b.leave();
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
