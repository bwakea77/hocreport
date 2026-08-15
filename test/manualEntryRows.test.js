const test = require('node:test');
const assert = require('node:assert/strict');
const { blankRow, collectCellUpdate } = require('../manualEntryRows');

test('blankRow creates an array of empty strings of the given width', () => {
  assert.deepEqual(blankRow(3), ['', '', '']);
  assert.deepEqual(blankRow(0), []);
});

test('collectCellUpdate queues a real value (including 0) and returns true', () => {
  const data = [];
  assert.equal(collectCellUpdate(data, 'Sheet1!A1', 0.247, 'test cell'), true);
  assert.equal(collectCellUpdate(data, 'Sheet1!A2', 0, 'zero-value cell'), true);
  assert.deepEqual(data, [
    { range: 'Sheet1!A1', values: [[0.247]] },
    { range: 'Sheet1!A2', values: [[0]] },
  ]);
});

// Regression test for the headline bug this session fixed: correctGmValues
// (hocReportsEntry.js) used to write '' whenever a re-scrape came back
// null/undefined, silently overwriting an already-correct cell from an
// earlier run. collectCellUpdate is the shared guard against that — it must
// never queue a write for a null/undefined value.
test('collectCellUpdate skips null/undefined instead of queuing a blank overwrite', () => {
  const data = [];
  assert.equal(collectCellUpdate(data, 'Sheet1!A1', null, 'test cell'), false);
  assert.equal(collectCellUpdate(data, 'Sheet1!A2', undefined, 'test cell'), false);
  assert.deepEqual(data, []); // nothing queued — any existing value in these cells is left alone
});
