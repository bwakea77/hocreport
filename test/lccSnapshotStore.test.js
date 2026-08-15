const test = require('node:test');
const assert = require('node:assert/strict');
const { compareLcc } = require('../lccSnapshotStore');

function sampleData(overrides = {}) {
  return {
    revenue: { actual: 1000000 },
    grossMargin: { actual: '24.7%' },
    ebitda: { actual: '10.1%' },
    channel: {
      externalTransport: { value: 500000, blendedGm: '20.0%' },
      transit: { value: 300000, blendedGm: '18.0%' },
      other: { value: 200000, blendedGm: '15.0%' },
    },
    ...overrides,
  };
}

test('compareLcc reports no diffs for identical snapshots', () => {
  const snap = { dateData: sampleData(), mtdData: sampleData() };
  assert.deepEqual(compareLcc(snap, snap), []);
});

test('compareLcc reports a diff when a channel value changes', () => {
  const previous = { dateData: sampleData(), mtdData: sampleData() };
  const current = {
    dateData: sampleData({
      channel: { ...sampleData().channel, transit: { value: 999999, blendedGm: '18.0%' } },
    }),
    mtdData: sampleData(),
  };
  const diffs = compareLcc(previous, current);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /Yesterday transit value: 300000 → 999999/);
});

test('compareLcc reports a diff when MTD gross margin changes but Yesterday stays stable', () => {
  const previous = { dateData: sampleData(), mtdData: sampleData() };
  const current = { dateData: sampleData(), mtdData: sampleData({ grossMargin: { actual: '30.0%' } }) };
  const diffs = compareLcc(previous, current);
  assert.deepEqual(diffs, ['MTD gross margin: 24.7% → 30.0%']);
});
