/* Runs tests.js (the same suite tests.html runs in a browser) under jsc
 * instead - a clean, fast, non-flaky alternative to the browser for exactly
 * the reason CLAUDE.md's Tests section describes: a backgrounded/automated
 * browser tab throttles timers hard enough to fail the async sync.js tests
 * on scheduling delay alone, nothing to do with the code. jsc has no DOM,
 * no timers, and no Firebase SDK, so all three are stubbed below - just
 * enough surface for rules.js/sync.js/tests.js to run against.
 *
 * Run from the repo root (jsc's load() resolves relative to cwd):
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc run-tests.js
 */

globalThis.window = globalThis;

/* Both web storages, because sync.js uses each for a different job (see
 * its identity comments): sessionStorage is the per-tab identity, and
 * localStorage is the cross-tab mirror a returning tab recovers its seat
 * from. Two separate stores here, not one shared object, precisely
 * because the difference between them is the thing under test. */
function fakeStorage() {
  const store = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
globalThis.sessionStorage = fakeStorage();
globalThis.localStorage = fakeStorage();

let resultsHTML = '';
globalThis.document = {
  hidden: false,
  addEventListener() {},
  createElement: () => ({
    classList: { add() {}, remove() {}, contains: () => false },
    style: {},
    dataset: {},
    appendChild() {},
  }),
  body: { appendChild() {} },
  querySelector: (sel) => (sel === '#results'
    ? { set innerHTML(v) { resultsHTML = v; }, get innerHTML() { return resultsHTML; } }
    : null),
  querySelectorAll: () => [],
};

globalThis.firebase = {
  database() { throw new Error('firebase.database() must not be reached - tests inject a fake via joinRoom'); },
};

/* jsc has no setTimeout, and the suite's waitFor() (tests.js) polls with it.
 * Minimal virtual-time queue: timers fire in due order, so a poll loop
 * advances instantly instead of sleeping in wall-clock time. Date.now is
 * bridged to the same clock so waitFor's own timeout budget stays
 * consistent with it rather than racing against real elapsed time. */
let virtualNow = 0;
let timerSeq = 0;
const pendingTimers = [];

globalThis.setTimeout = (fn, ms) => {
  const id = ++timerSeq;
  pendingTimers.push({ id, at: virtualNow + (ms || 0), seq: id, fn });
  return id;
};
globalThis.clearTimeout = (id) => {
  const i = pendingTimers.findIndex((t) => t.id === id);
  if (i !== -1) pendingTimers.splice(i, 1);
};
const realDateNow = Date.now;
Date.now = () => virtualNow;

load('rules.js');
load('sync.js');
load('tests.js');

// Drive the loop: alternate microtasks (promises) with the next due timer.
drainMicrotasks();
let guard = 0;
while (pendingTimers.length && guard++ < 2000000) {
  pendingTimers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const timer = pendingTimers.shift();
  virtualNow = Math.max(virtualNow, timer.at);
  timer.fn();
  drainMicrotasks();
}
Date.now = realDateNow;

const results = globalThis.__testResults;
if (!results) {
  print('NO RESULTS - suite did not finish (a test likely hung; check for a missing setTimeout/Promise path)');
  quit(1);
} else {
  print(`${results.passed}/${results.total} passed` + (results.failed ? ` - ${results.failed} FAILED` : ''));
  results.results
    .filter((r) => !r.passed)
    .forEach((r) => print(`  FAIL: ${r.name}\n        ${r.message}`));
  if (results.failed) quit(1);
}
