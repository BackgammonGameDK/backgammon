/* Multiplayer transport, backed by Firebase Realtime Database (Stage D).
 *
 * Replaces Stage C's local-only rehearsal (localStorage + BroadcastChannel,
 * which only worked between tabs of one browser) with the real thing: two
 * separate devices, anywhere, sharing a room over the internet. script.js
 * did not need to change for this swap - it was already written against
 * joinRoom(...)'s callback timing (onRoom never fires synchronously), which
 * is what Firebase's onValue naturally does too.
 *
 * The room record at /rooms/<code> is Stage C's, plus the keys added
 * since: { seats: {white, black}, state, seq, presence, departed,
 * lastActive }.
 * database.rules.json restricts
 * read/write to a specific room path, and only to someone who already
 * knows its code - there is no listing, no accounts, matching the
 * friend-level trust model decided up front.
 *
 * `database` in joinRoom's options is a seam for tests: it defaults to
 * firebase.database(), but tests pass an in-memory fake implementing the
 * same handful of calls (ref/transaction/on/off/set), so the test suite
 * never makes a real network call. `clientId` is the equivalent seam
 * carried over from Stage C, for simulating two different tabs from one
 * test page, and `recoveredClientId` alongside it stands in for the
 * localStorage mirror a returning tab reclaims its seat with (see
 * identityFor) - both are per-tab storage, which can't be faked from a
 * single test page.
 */

const CLIENT_ID_PREFIX = 'bg:client:';

/* The localStorage half of identityFor below - a mirror of the same id,
   under a different key so the two stores can never be confused for each
   other while debugging. */
const RECOVERY_ID_PREFIX = 'bg:seat:';

/* The most recent room this browser joined, offered back on the start
   screen so a player who closed the tab can get back in without the
   invite link. One value, not one per room - "the room I was in" is
   singular, and a list would be a history feature nobody asked for. */
const LAST_ROOM_KEY = 'bg:last-room';

/* Firebase's server-timestamp sentinel: the database replaces this exact
   object with its own clock at write time. Written literally rather than
   read from firebase.database.ServerValue.TIMESTAMP - which is precisely
   this value - to preserve something that matters for testing:
   defaultDatabase() is the only place in this file that touches the
   `firebase` global, which is what lets both runners exercise sync.js
   without the SDK loaded at all. tests.html in particular loads only
   rules.js, sync.js and tests.js, so a second global reference would throw
   there rather than politely fall back.

   Server time, not Date.now(), because the point of the value is deciding
   which rooms are stale: a device with a wrong clock would otherwise make
   a dead room look fresh, or bury a live one. */
const SERVER_TIMESTAMP = { '.sv': 'timestamp' };

/* Guarded, unlike identityFor's storage access, for a reason worth
   stating: identityFor only runs when someone actually joins a room,
   whereas lastRoomCode runs on *every* page load to decide whether the
   start screen shows a Rejoin button. Safari's private mode has
   historically thrown on storage access, and a throw here would take the
   whole app down for a visitor who only ever wanted a hot-seat game and
   never touched storage before this feature existed. Losing the Rejoin
   button is an acceptable failure; losing the game is not. */
function rememberRoom(roomCode) {
  try {
    localStorage.setItem(LAST_ROOM_KEY, roomCode);
  } catch (error) {
    /* no rejoin offer next time, nothing else affected */
  }
}

function lastRoomCode() {
  try {
    return localStorage.getItem(LAST_ROOM_KEY);
  } catch (error) {
    return null;
  }
}

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

/* A tab's identity within a room, plus the id it means to reclaim a seat
   under if it turns out to be a tab that lost its identity.

   `clientId` is per-tab and lives in sessionStorage, not localStorage:
   localStorage is shared across every tab of one origin, so using it as
   the identity would make two tabs open to the same room collapse into a
   single "client" unable to hold two seats. sessionStorage is per-tab - a
   reload of the same tab reclaims the same seat, a second tab gets a
   different id and can claim the other seat.

   `recoveredClientId` exists because that per-tab guarantee has a cost on
   mobile: a browser discarding a backgrounded tab throws its
   sessionStorage away too, so a player returning to a game hours later
   arrives as a brand-new client, finds both seats still claimed (they are
   never freed, see claimSeat) and is demoted to spectator - locked out of
   their own game with no way back except editing the room code off the
   URL by hand. So the id is *also* mirrored to localStorage, which
   survives that. When sessionStorage comes up empty, that mirror is
   offered to claimSeat as a candidate - not as an identity, only as a
   claim to a seat, which claimSeat honours solely if nobody is currently
   sitting in it.

   Both halves are one function rather than two on purpose: the mirror has
   to be read *before* sessionStorage is written, or sessionStorage is
   never empty and no candidate is ever offered. Split across two calls,
   getting that order wrong would silently disable seat recovery, and
   nothing would fail loudly enough to notice.

   Known limitation, accepted: the mirror holds one id per room, the most
   recent tab's. Two tabs of one browser in the same room, where the first
   is then discarded, leaves that first tab unable to recover - the mirror
   has moved on to the second. That's a development and testing shape, not
   how two people play, and a per-room set of candidates is more machinery
   than this trust model warrants. */
function identityFor(roomCode) {
  const sessionKey = CLIENT_ID_PREFIX + roomCode;
  const recoveryKey = RECOVERY_ID_PREFIX + roomCode;

  let clientId = sessionStorage.getItem(sessionKey);
  const recoveredClientId = clientId ? null : localStorage.getItem(recoveryKey);

  if (!clientId) {
    clientId = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(sessionKey, clientId);
  }
  localStorage.setItem(recoveryKey, clientId);

  return { clientId, recoveredClientId };
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

   `recoveredClientId` (optional, see identityFor) is a claim to a seat
   held under a previous identity, for a tab whose sessionStorage was
   discarded. It is honoured only when that seat has no presence entry -
   which is the whole reason presence has to be consulted here rather than
   just trusting the candidate. Two situations produce an identical room
   record apart from presence: a player returning to a seat nobody is
   sitting in, and a second tab opening alongside a live one, since
   localStorage is shared origin-wide and the second tab finds the first
   tab's mirrored id too. Presence is the only thing that tells them
   apart, so the rule is "reclaim an abandoned seat, never occupy a live
   one" - and a candidate holding no seat at all is simply ignored, so a
   stale or invented one can't become a way to take a seat off somebody.

   Checked after the two identity cases above but before the empty-seat
   cases below: a client that already holds a seat under its own id needs
   no recovery, while a client that is recovering must land back in its
   own seat rather than whichever one happens to be free.

   Mutates room.seats in place. Used as the body of a Firebase transaction,
   which may run it more than once under contention - safe here because
   each retry gets a fresh `room` (transaction always hands us `current ||
   emptyRoom()`, never something we mutated on a previous attempt), and the
   function has no effect outside of what it returns. */
function claimSeat(room, clientId, recoveredClientId) {
  if (room.seats.white === clientId) {
    return room;
  }
  if (room.seats.black === clientId) {
    return room;
  }
  const recoveredSeat = recoveredClientId ? seatFor(room.seats, recoveredClientId) : 'spectator';
  if (recoveredSeat !== 'spectator' && !(room.presence && room.presence[recoveredSeat])) {
    room.seats[recoveredSeat] = clientId;
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

/* Presence: written to /rooms/<code>/presence/<color> (a plain `true` while
   connected) so the other seat can tell "opponent hasn't shown up yet"
   (seat claimed, no presence entry) apart from "opponent was here and
   left" (seat claimed, presence entry gone) - claimSeat never frees a seat
   once taken (a reload is meant to reclaim it, see identityFor above), so
   seat occupancy alone can't distinguish those two cases.

   Built on Firebase's .info/connected + onDisconnect() idiom: onDisconnect
   registers an action *on the server*, to run when the server itself
   notices this connection drop - not something the client executes, so it
   fires on a closed tab, a lost network, or a crash, not only a clean page
   unload. It's re-armed every time .info/connected flips to true rather
   than once, because a previous registration doesn't survive the
   disconnect that triggered it; a client that drops and reconnects has to
   re-register or a second real disconnect would go unnoticed.

   A spectator gets no presence entry - there's no seat for the other
   player to be waiting on. Returns a detach function for leave().

   Connecting also clears this seat's `departed` flag (see leave below):
   whatever that seat did last time, someone is sitting in it now, so the
   opponent should stop being told it was abandoned. */
function attachPresence(db, roomCode, color) {
  if (color === 'spectator') {
    return () => {};
  }
  const presenceRef = db.ref('rooms/' + roomCode + '/presence/' + color);
  const departedRef = db.ref('rooms/' + roomCode + '/departed/' + color);
  const connectedRef = db.ref('.info/connected');
  const handler = (snapshot) => {
    if (snapshot.val() !== true) {
      return;
    }
    presenceRef.onDisconnect().remove().then(() => {
      presenceRef.set(true);
      departedRef.remove();
    });
  };
  connectedRef.on('value', handler);
  return () => {
    connectedRef.off('value', handler);
    presenceRef.remove();
  };
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
  /* `phase` defaults to playing for any record written before the opening
     phase existed - there are none that matter, but a state arriving
     without it should behave like a game in progress rather than sending
     both players back to roll for the start.

     openingRoll needs more care than a simple `|| null`, and it is the
     sharpest instance of the null-stripping problem in this file. A fresh
     opening state's roll is `{ white: null, black: null }`, which Firebase
     stores as nothing at all - the key is simply absent on read. Half a
     round (`{ white: 4, black: null }`) comes back as `{ white: 4 }`. So
     during the opening phase both keys are put back explicitly; rules.js
     compares them against null and would read a missing key as "not yet
     rolled" by luck rather than by contract. Outside that phase the value
     is genuinely null once the first turn ends, and `|| null` is right. */
  const phase = raw.phase || 'playing';
  const openingRoll =
    phase === 'opening'
      ? {
          white: raw.openingRoll && raw.openingRoll.white != null ? raw.openingRoll.white : null,
          black: raw.openingRoll && raw.openingRoll.black != null ? raw.openingRoll.black : null,
        }
      : raw.openingRoll || null;

  return {
    points,
    bar: raw.bar,
    off: raw.off,
    dice: raw.dice || [],
    currentPlayer: raw.currentPlayer,
    winner: raw.winner || null,
    phase,
    openingRoll,
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
function joinRoom(roomCode, { onRoom }, { clientId: clientIdOverride, recoveredClientId: recoveredOverride, database } = {}) {
  /* An injected clientId means a test standing in for a tab, so the
     recovery candidate is injected alongside it rather than read from
     storage - identityFor writes as well as reads, and calling it here
     would have one fake tab quietly overwrite another's mirror. Real
     callers pass neither and get both from storage. */
  const identity = clientIdOverride
    ? { clientId: clientIdOverride, recoveredClientId: recoveredOverride || null }
    : identityFor(roomCode);
  const clientId = identity.clientId;
  const recoveredClientId = identity.recoveredClientId;
  const db = database || defaultDatabase();
  const roomRef = db.ref('rooms/' + roomCode);

  let color = 'spectator';
  let latestRoom = emptyRoom();
  let valueHandler = null;
  let detachPresence = () => {};

  roomRef.transaction((current) => claimSeat(current || emptyRoom(), clientId, recoveredClientId)).then((result) => {
    color = seatFor(result.snapshot.val().seats, clientId);
    detachPresence = attachPresence(db, roomCode, color);

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
     seq numbers instead of racing to read the same stale value.

     Written with roomRef.update() rather than .set(): a plain .set() at
     the room path would replace the whole record, including presence -
     which changes on its own timeline (a disconnect can flip it between
     this client's last-seen snapshot and its next move) and isn't this
     client's to overwrite. update() patches only the keys given, leaving
     the other seat's presence entry alone regardless of when it last
     changed. */
  function sendState(state) {
    const next = { seats: latestRoom.seats, state: serializeState(state), seq: (latestRoom.seq || 0) + 1 };
    latestRoom = { ...latestRoom, ...next };
    /* lastActive rides along on the same update() rather than a write of
       its own, so it cannot land separately from the move that caused it.
       Kept out of the optimistic latestRoom merge above deliberately: until
       the server resolves it, it is a sentinel rather than a time, and
       latestRoom is only ever read for seats and seq anyway.

       Nothing writes it on join. A room whose second player never arrived
       therefore has no lastActive at all, which is a more useful signal
       than a timestamp would be: it says the room was never played, rather
       than played and gone quiet. */
    roomRef.update({ ...next, lastActive: SERVER_TIMESTAMP });
  }

  /* `departed: true` says this client is leaving on purpose, as opposed to
     its connection simply going away. Both end with presence cleared, so
     without this the two are indistinguishable in the room record and the
     opponent gets the same "opponent disconnected" either way - which is
     the wrong thing to tell someone whose opponent has actually quit and
     isn't coming back mid-turn. The flag is written before presence is
     dropped, and cleared again by attachPresence if that seat is ever
     reoccupied.

     A spectator never sets it: there is no seat for anyone to be waiting
     on, so there is nothing to announce. */
  function leave({ departed } = {}) {
    if (departed && color !== 'spectator') {
      db.ref('rooms/' + roomCode + '/departed/' + color).set(true);
    }
    if (valueHandler) {
      roomRef.off('value', valueHandler);
    }
    detachPresence();
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
