/* Local-only multiplayer transport (Stage C).
 *
 * Stands in for what Firebase Realtime Database will provide in Stage D: a
 * shared "room" record that any client can read, write, and subscribe to
 * changes on. localStorage plays the role of the persisted store, so a
 * reloaded or late-joining tab can read the current game immediately - the
 * way Firebase's onValue delivers the current value on first subscribe.
 * BroadcastChannel plays the role of the realtime push notification.
 *
 * Firebase gives both of those from one API, so script.js is written
 * against the joinRoom(...) interface below rather than against
 * localStorage/BroadcastChannel directly - swapping this file's internals
 * for a Firebase-backed version in Stage D shouldn't require changing how
 * it's called.
 *
 * Only works between tabs of the same browser on the same machine - there
 * is no actual network involved, which is the point of this stage: proving
 * out rooms, seats, and state sync before any backend exists.
 */

const CHANNEL_PREFIX = 'bg:room:';
const STORAGE_PREFIX = 'bg:room:';
const CLIENT_ID_PREFIX = 'bg:client:';

/* Short, easy to read aloud or type into a second tab. Skips 0/O and 1/I,
   which are the pairs people actually mistype. */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function readRoom(roomCode) {
  const raw = localStorage.getItem(STORAGE_PREFIX + roomCode);
  return raw ? JSON.parse(raw) : null;
}

function writeRoom(roomCode, room) {
  localStorage.setItem(STORAGE_PREFIX + roomCode, JSON.stringify(room));
}

function emptyRoom() {
  return { seats: { white: null, black: null }, state: null, seq: 0 };
}

/* A tab's identity within a room, persisted in sessionStorage rather than
   localStorage. localStorage is shared across every tab of the same
   origin, so using it here would make two tabs open to the same room
   collapse into a single "client" unable to hold two seats.
   sessionStorage is per-tab: a reload of the same tab reclaims the same
   seat, a second tab gets a different id and can claim the other seat, and
   closing the tab forgets it. */
function clientIdFor(roomCode) {
  const key = CLIENT_ID_PREFIX + roomCode;
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(key, id);
  }
  return id;
}

/* First-come-first-served: an empty seat goes to whoever asks for one
   first. A client re-joining with an id it already holds a seat under
   (i.e. a reload) reclaims that seat rather than being treated as new.
   Anyone else once both seats are taken watches as a spectator - a
   deliberate simplification for a two-player game under friend-level
   trust, not a general presence system.

   Mutates room.seats in place; callers always pass a freshly-read or
   freshly-created room object, so this never aliases anything shared. */
function claimSeat(room, clientId) {
  if (room.seats.white === clientId) {
    return 'white';
  }
  if (room.seats.black === clientId) {
    return 'black';
  }
  if (!room.seats.white) {
    room.seats.white = clientId;
    return 'white';
  }
  if (!room.seats.black) {
    room.seats.black = clientId;
    return 'black';
  }
  return 'spectator';
}

/* Joins (or creates) a room and returns a handle:
 *   { clientId, color, sendState(state), leave() }
 *
 * onRoom(room, color) fires once with whatever is already in the room
 * (possibly empty), and again every time it changes - whether this client
 * changed it or another one did. Routing both through the same callback is
 * what keeps a sender's own view consistent with what a receiver sees: there
 * is only one "the room changed, react to it" code path to get right, not a
 * separate optimistic-update path for the sender.
 *
 * The initial call is deferred to a microtask rather than fired
 * synchronously, for two reasons: it lets the caller finish assigning the
 * return value to a variable before its own callback can run, and it
 * matches Firebase's onValue, which never calls back synchronously either -
 * so code written against this timing carries over to Stage D unchanged.
 *
 * `clientId` in the third argument is a seam for tests, which need to
 * simulate two different tabs from within one page - real callers never
 * pass it and get one derived from sessionStorage instead.
 */
function joinRoom(roomCode, { onRoom }, { clientId: clientIdOverride } = {}) {
  const clientId = clientIdOverride || clientIdFor(roomCode);
  const channel = new BroadcastChannel(CHANNEL_PREFIX + roomCode);

  let room = readRoom(roomCode) || emptyRoom();
  const color = claimSeat(room, clientId);
  writeRoom(roomCode, room);
  channel.postMessage(room);

  channel.onmessage = (event) => {
    room = event.data;
    onRoom(room, color);
  };

  Promise.resolve().then(() => onRoom(room, color));

  function sendState(state) {
    room = { ...room, state, seq: room.seq + 1 };
    writeRoom(roomCode, room);
    channel.postMessage(room);
    onRoom(room, color);
  }

  function leave() {
    channel.close();
  }

  return { clientId, color, sendState, leave };
}
