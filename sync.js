/* Multiplayer transport, backed by Firebase Realtime Database (Stage D).
 *
 * Replaces Stage C's local-only rehearsal (localStorage + BroadcastChannel,
 * which only worked between tabs of one browser) with the real thing: two
 * separate devices, anywhere, sharing a room over the internet. script.js
 * did not need to change for this swap - it was already written against
 * joinRoom(...)'s callback timing (onRoom never fires synchronously), which
 * is what Firebase's onValue naturally does too.
 *
 * The room record at /rooms/<code> is exactly what it was in Stage C:
 * { seats: {white, black}, state, seq }. database.rules.json restricts
 * read/write to a specific room path, and only to someone who already
 * knows its code - there is no listing, no accounts, matching the
 * friend-level trust model decided up front.
 *
 * `database` in joinRoom's options is a seam for tests: it defaults to
 * firebase.database(), but tests pass an in-memory fake implementing the
 * same handful of calls (ref/transaction/on/off/set), so the test suite
 * never makes a real network call. `clientId` is the equivalent seam
 * carried over from Stage C, for simulating two different tabs from one
 * test page.
 */

const CLIENT_ID_PREFIX = 'bg:client:';

/* Short, easy to read aloud or type into a second device. Skips 0/O and
   1/I, which are the pairs people actually mistype. Six characters (up
   from Stage C's four) because a room now only needs to be found by
   someone who already knows its code - the code itself has to do more
   work as the sole gate, once it's reachable from the whole internet
   rather than just two tabs on one machine. */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

function randomRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/* A tab's identity within a room, persisted in sessionStorage rather than
   localStorage. localStorage is shared across every tab of the same
   origin, so using it here would make two tabs open to the same room
   collapse into a single "client" unable to hold two seats. sessionStorage
   is per-tab: a reload of the same tab reclaims the same seat, a second
   tab gets a different id and can claim the other seat, and closing the
   tab forgets it. */
function clientIdFor(roomCode) {
  const key = CLIENT_ID_PREFIX + roomCode;
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(key, id);
  }
  return id;
}

function emptyRoom() {
  return { seats: { white: null, black: null }, state: null, seq: 0 };
}

/* First-come-first-served: an empty seat goes to whoever asks for one
   first. A client re-joining with an id it already holds a seat under
   (i.e. a reload) reclaims that seat rather than being treated as new.
   Anyone else once both seats are taken watches as a spectator - a
   deliberate simplification for a two-player game under friend-level
   trust, not a general presence system.

   Mutates room.seats in place. Used as the body of a Firebase transaction,
   which may run it more than once under contention - safe here because
   each retry gets a fresh `room` (transaction always hands us `current ||
   emptyRoom()`, never something we mutated on a previous attempt), and the
   function has no effect outside of what it returns. */
function claimSeat(room, clientId) {
  if (room.seats.white === clientId) {
    return room;
  }
  if (room.seats.black === clientId) {
    return room;
  }
  if (!room.seats.white) {
    room.seats.white = clientId;
    return room;
  }
  if (!room.seats.black) {
    room.seats.black = clientId;
    return room;
  }
  return room;
}

function seatFor(seats, clientId) {
  if (seats.white === clientId) {
    return 'white';
  }
  if (seats.black === clientId) {
    return 'black';
  }
  return 'spectator';
}

function defaultDatabase() {
  return firebase.database();
}

/* Firebase never actually stores a null value or an empty object/array -
 * writing one just makes that key absent from what a listener reads back.
 * Confirmed directly against the live database, not assumed from
 * documentation: a sparse array (rules.js's 25-slot `points`, where most
 * points are empty) round-trips as a bare object holding only the present
 * indices, not as an array with gaps; an empty `dice` array or a null
 * `state`/`winner` simply isn't there on read.
 *
 * rules.js and script.js should not have to know any of that - they
 * already have a clean, complete shape from createInitialState(). These
 * two functions are the only place that translates between it and
 * whatever survives a Firebase round trip: serializeState right before
 * every write, deserializeState right after every read.
 */
function serializeState(state) {
  if (!state) {
    return state;
  }
  const points = {};
  state.points.forEach((point, index) => {
    if (point) {
      points[index] = point;
    }
  });
  return { ...state, points, dice: state.dice.length ? state.dice : null };
}

function deserializeState(raw) {
  if (!raw) {
    return raw;
  }
  const points = new Array(25).fill(null);
  Object.keys(raw.points || {}).forEach((index) => {
    points[Number(index)] = raw.points[index];
  });
  return {
    points,
    bar: raw.bar,
    off: raw.off,
    dice: raw.dice || [],
    currentPlayer: raw.currentPlayer,
    winner: raw.winner || null,
  };
}

/* Joins (or creates) a room and returns a handle:
 *   { clientId, sendState(state), leave(), color }
 * (`color` is a live getter - 'spectator' until the seat-claiming
 * transaction resolves, then whichever seat this client actually landed
 * in.)
 *
 * onRoom(room, color) fires every time the room changes - whether this
 * client changed it or another one did, and including this client's own
 * writes, which Firebase echoes back to its own listeners. Routing both
 * through the same callback is what keeps a sender's own view consistent
 * with what a receiver sees: there is only one "the room changed, react to
 * it" code path to get right, not a separate optimistic-update path for
 * the sender.
 *
 * The value listener is deliberately not attached until the seat-claiming
 * transaction has resolved, rather than attaching it first and patching
 * `color` in later - otherwise an early 'value' event (Firebase fires one
 * immediately on attach, with whatever is there right now) could reach
 * onRoom before this client's own color is known, handing the caller a
 * wrong 'spectator' default for what's actually its own seat.
 */
function joinRoom(roomCode, { onRoom }, { clientId: clientIdOverride, database } = {}) {
  const clientId = clientIdOverride || clientIdFor(roomCode);
  const db = database || defaultDatabase();
  const roomRef = db.ref('rooms/' + roomCode);

  let color = 'spectator';
  let latestRoom = emptyRoom();
  let valueHandler = null;

  roomRef.transaction((current) => claimSeat(current || emptyRoom(), clientId)).then((result) => {
    color = seatFor(result.snapshot.val().seats, clientId);

    /* latestRoom is kept in Firebase's native (serialized) shape - it's only
       ever used below for its seats/seq, which round-trip untouched, so
       there's no need to deserialize it just to immediately re-serialize it
       again on the next sendState. onRoom, on the other hand, is script.js's
       contract and must always see the same clean shape createInitialState()
       produces - that's the one place `raw.state` gets deserialized. */
    valueHandler = (snapshot) => {
      const raw = snapshot.val();
      if (!raw) {
        return;
      }
      latestRoom = raw;
      onRoom({ ...raw, state: deserializeState(raw.state) }, color);
    };
    roomRef.on('value', valueHandler);
  });

  /* Updates latestRoom optimistically before the write completes, rather
     than waiting on a round trip to read it back - so two sendState calls
     made in quick succession (which shouldn't normally happen, since
     script.js only calls this once per committed move) still get distinct
     seq numbers instead of racing to read the same stale value. */
  function sendState(state) {
    const next = { ...latestRoom, state: serializeState(state), seq: (latestRoom.seq || 0) + 1 };
    latestRoom = next;
    roomRef.set(next);
  }

  function leave() {
    if (valueHandler) {
      roomRef.off('value', valueHandler);
    }
  }

  return {
    clientId,
    sendState,
    leave,
    get color() {
      return color;
    },
  };
}
