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
 * sync.js talks to Firebase through a tiny slice of its API - ref(path),
 * .transaction(), .on('value'), .off('value'), .set() - injected via
 * joinRoom's `database` option. These tests exercise that same slice
 * against a small in-memory fake rather than a real Firebase project, so
 * the suite stays fast and has no network dependency; it deliberately does
 * NOT re-test Firebase itself (that's Firebase's job), only how sync.js
 * uses it - seat assignment, initial-state seeding, propagation.
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

function createFakeDatabase() {
  const store = {};
  const listeners = {};

  function notify(path) {
    const cbs = listeners[path];
    if (!cbs) {
      return;
    }
    const value = path in store ? store[path] : null;
    cbs.forEach((cb) => setTimeout(() => cb({ val: () => value }), 0));
  }

  return {
    ref(path) {
      return {
        transaction(updateFn) {
          return new Promise((resolve) => {
            setTimeout(() => {
              const current = path in store ? store[path] : null;
              const next = stripNulls(updateFn(current)) ?? null;
              store[path] = next;
              notify(path);
              resolve({ committed: true, snapshot: { val: () => next } });
            }, 0);
          });
        },
        on(event, cb) {
          if (event !== 'value') {
            return;
          }
          listeners[path] = listeners[path] || new Set();
          listeners[path].add(cb);
          notify(path);
        },
        off(event, cb) {
          if (listeners[path]) {
            listeners[path].delete(cb);
          }
        },
        set(value) {
          store[path] = stripNulls(value) ?? null;
          notify(path);
          return Promise.resolve();
        },
      };
    },
  };
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
