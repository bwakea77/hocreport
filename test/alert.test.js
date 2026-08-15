const test = require('node:test');
const assert = require('node:assert/strict');
const {
  queueAlert,
  queueSuccessIfClean,
  filterFreshPending,
  capPendingEntries,
  _resetForTest,
  _peekQueuedForTest,
} = require('../alert');

test('filterFreshPending keeps entries within the age cutoff and drops older/malformed ones', () => {
  const now = Date.parse('2026-08-15T00:00:00.000Z');
  const entries = [
    { message: 'fresh', queuedAt: new Date(now - 1000).toISOString() },
    { message: 'too old', queuedAt: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString() },
    { queuedAt: new Date(now).toISOString() }, // no `message` string -> dropped regardless of age
  ];
  const kept = filterFreshPending(entries, now);
  assert.deepEqual(kept.map((e) => e.message), ['fresh']);
});

test('capPendingEntries keeps only the most recent MAX_PENDING_ENTRIES (50)', () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ message: `m${i}`, queuedAt: new Date().toISOString() }));
  const kept = capPendingEntries(entries);
  assert.equal(kept.length, 50);
  assert.equal(kept[0].message, 'm10'); // oldest 10 dropped
  assert.equal(kept[kept.length - 1].message, 'm59');
});

// Regression test for the "every run posts something in Slack" requirement:
// a clean run must still emit exactly one message, but a run that already
// queued a warning/failure must not also get a contradictory success line.
test('queueSuccessIfClean queues its message when nothing else was queued this run', () => {
  _resetForTest();
  queueSuccessIfClean('✅ all good');
  assert.deepEqual(_peekQueuedForTest().map((e) => e.message), ['✅ all good']);
});

test('queueSuccessIfClean stays silent if a warning/failure was already queued this run', () => {
  _resetForTest();
  queueAlert('⚠️ something is off');
  queueSuccessIfClean('✅ all good');
  assert.deepEqual(_peekQueuedForTest().map((e) => e.message), ['⚠️ something is off']);
});
