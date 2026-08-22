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

/* ---- opening roll (deciding who starts) ---- */

test('the higher single-die roll starts, keeping both rolls as its first turn\'s dice', () => {
  const result = rollOpeningRoll(sequenceRandom([0.95, 0.45])); // 6 vs 3
  assertEqual(result, { white: 6, black: 3, starter: 'white' });
});

test('a tied opening roll is rerolled rather than left unresolved', () => {
  const result = rollOpeningRoll(sequenceRandom([0.45, 0.45, 0.95, 0.25])); // tie at 3-3, then 6 vs 2
  assertEqual(result, { white: 6, black: 2, starter: 'white' });
});

test('createInitialState wires the opening roll into currentPlayer, dice, and openingRoll', () => {
  const state = createInitialState(sequenceRandom([0.25, 0.75])); // 2 vs 5
  assertEqual(state.currentPlayer, 'black', 'higher roll (5) starts');
  assertEqual(state.dice.map((d) => d.value), [2, 5], 'both individual rolls become the first turn\'s dice');
  assertEqual(state.openingRoll, { white: 2, black: 5 });
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
    const cleaned = stripNulls(value);
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

  return {
    ref(path) {
      return {
        transaction(updateFn) {
          return new Promise((resolve) => {
            setTimeout(() => {
              const current = getNode(path) ?? null;
              const next = updateFn(current);
              writeNode(path, next);
              notify(path);
              const committed = getNode(path) ?? null;
              resolve({ committed: true, snapshot: { val: () => committed } });
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
 * A tab's identity lives in sessionStorage (clientIdFor), which is what
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
