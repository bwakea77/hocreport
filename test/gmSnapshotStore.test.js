const test = require('node:test');
const assert = require('node:assert/strict');
const { compareGm } = require('../gmSnapshotStore');

function baseline() {
  return {
    BUNJU: { daily: 0.25, mtd: 0.26 },
    KINYEREZI: { daily: 0.2, mtd: 0.21 },
    DODOMA: { daily: 0.18, mtd: 0.19 },
    ONJA: { daily: 0.3, mtd: 0.31 },
    OVERALL: { daily: 0.24, mtd: 0.245 },
  };
}

test('compareGm reports no diffs when figures match within epsilon', () => {
  const prev = baseline();
  const curr = { ...baseline(), BUNJU: { daily: 0.2503, mtd: 0.26 } }; // 0.03pp move, below the 0.05pp epsilon
  assert.deepEqual(compareGm(prev, curr), []);
});

test('compareGm reports a diff when a figure moves beyond epsilon', () => {
  const prev = baseline();
  const curr = { ...baseline(), BUNJU: { daily: 0.3, mtd: 0.26 } };
  const diffs = compareGm(prev, curr);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /BUNJU daily: 25\.0% → 30\.0%/);
});

// This is exactly the scenario correctGmValues (hocReportsEntry.js) must
// handle without blanking the already-correct cell: compareGm still flags it
// as "changed" (real value -> null), which is what triggers a correction
// write in index.js — the correction write itself must then skip the null
// field rather than overwrite with blank (see manualEntryRows.test.js).
test('compareGm reports a diff when a previously-good figure goes missing (null) on re-scrape', () => {
  const prev = baseline();
  const curr = { ...baseline(), BUNJU: { daily: null, mtd: 0.26 } };
  const diffs = compareGm(prev, curr);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /BUNJU daily: 25\.0% → -/);
});
