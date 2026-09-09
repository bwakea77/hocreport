// Regression tests for the placeholder read that zeroed real MTD GM in the
// sheet on 2026-09-01 and 2026-09-06. See isUnpopulatedSnapshot in scraper.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnpopulatedSnapshot, readUntilStable, rejectSnapshot, rangeLabelFor } = require('../scraper');

const snapshot = (bunju, dodoma, kinyerezi, onja, overallRaw) => ({
  perBranch: { BUNJU: bunju, DODOMA: dodoma, KINYEREZI: kinyerezi, ONJA: onja },
  overallRaw,
});

// A fake Playwright page — readUntilStable only ever calls waitForTimeout.
const fakePage = () => ({ waitForTimeout: async () => {} });

test('isUnpopulatedSnapshot flags the all-zero placeholder', () => {
  assert.equal(isUnpopulatedSnapshot(snapshot(0, 0, 0, 0, '0.0%')), true);
});

test('isUnpopulatedSnapshot flags an all-empty read', () => {
  assert.equal(isUnpopulatedSnapshot(snapshot(null, null, null, null, null)), true);
  // Mixed zeros and dashes is still the placeholder — 2026-09-01 read exactly
  // this shape (BUNJU/DODOMA/OVERALL 0.0%, KINYEREZI/ONJA "—").
  assert.equal(isUnpopulatedSnapshot(snapshot(0, 0, null, null, '0.0%')), true);
});

test('isUnpopulatedSnapshot accepts a genuine single-branch zero', () => {
  // Confirmed live on the EAF dashboard 2026-09-09: "Onja Channel" read 0.0%
  // while the other three branches were 19.7%/14.1%/8.2%. Rejecting any zero
  // would discard real data, so only an all-zero snapshot counts.
  assert.equal(isUnpopulatedSnapshot(snapshot(0.082, 0.141, 0.197, 0, '14.2%')), false);
});

test('isUnpopulatedSnapshot accepts a normal reading', () => {
  assert.equal(isUnpopulatedSnapshot(snapshot(0.202, 0.302, 0.218, 0.056, '22.2%')), false);
});

test('readUntilStable returns a reading once two consecutive reads agree', async () => {
  const reads = [snapshot(0.1, 0.2, 0.3, 0.4, '2.5%'), snapshot(0.202, 0.302, 0.218, 0.056, '22.2%'), snapshot(0.202, 0.302, 0.218, 0.056, '22.2%')];
  let i = 0;
  const result = await readUntilStable(fakePage(), async () => reads[i++], { intervalMs: 0, rejectIf: isUnpopulatedSnapshot });
  assert.equal(result.overallRaw, '22.2%');
});

test('readUntilStable never returns the placeholder, however stable it is', async () => {
  // The exact failure from 2026-09-06: every read agrees, and every read is
  // zeros. Stability alone accepted it; the guard must not.
  const page = fakePage();
  await assert.rejects(
    () => readUntilStable(page, async () => snapshot(0, 0, 0, 0, '0.0%'), { intervalMs: 0, settleTimeoutMs: 50, rejectIf: isUnpopulatedSnapshot }),
    /never stabilized.*stayed unpopulated/
  );
});

test('readUntilStable waits out a placeholder that later populates', async () => {
  const reads = [
    snapshot(0, 0, 0, 0, '0.0%'),
    snapshot(0, 0, 0, 0, '0.0%'),
    snapshot(0.202, 0.302, 0.218, 0.056, '22.2%'),
    snapshot(0.202, 0.302, 0.218, 0.056, '22.2%'),
  ];
  let i = 0;
  const result = await readUntilStable(fakePage(), async () => reads[i++], { intervalMs: 0, rejectIf: isUnpopulatedSnapshot });
  assert.equal(result.overallRaw, '22.2%');
});

test('rangeLabelFor builds the label the dashboard renders', () => {
  assert.equal(rangeLabelFor(new Date(2026, 7, 1), new Date(2026, 7, 31)), '01 Aug - 31 Aug 2026');
  assert.equal(rangeLabelFor(new Date(2026, 8, 8), new Date(2026, 8, 8)), '08 Sep - 08 Sep 2026');
});

test('rejectSnapshot rejects a populated read taken off the wrong date range', () => {
  // 2026-09-09: a read of the 01 Aug - 31 Aug range came back with the
  // default "today" view's figures. Perfectly populated, perfectly stable,
  // wrong period — and nothing downstream could tell. An immediate re-run of
  // the identical call returned the correct August MTD.
  const wrongRange = { ...snapshot(0.291, 0.186, 0.256, 0, '25.5%'), rangeLabelPresent: false };
  assert.equal(rejectSnapshot(wrongRange), true);
  const rightRange = { ...snapshot(0.231, 0.228, 0.162, 0.285, '21.0%'), rangeLabelPresent: true };
  assert.equal(rejectSnapshot(rightRange), false);
});

test('readUntilStable waits out a stale range and returns the correct one', async () => {
  const stale = { ...snapshot(0.291, 0.186, 0.256, 0, '25.5%'), rangeLabelPresent: false };
  const good = { ...snapshot(0.231, 0.228, 0.162, 0.285, '21.0%'), rangeLabelPresent: true };
  const reads = [stale, stale, good, good];
  let i = 0;
  const result = await readUntilStable(fakePage(), async () => reads[i++], { intervalMs: 0, rejectIf: rejectSnapshot });
  assert.equal(result.overallRaw, '21.0%');
});

test('a placeholder read cannot pair with a later real read to look stable', async () => {
  // Guards the reset of `previous` on rejection: without it, a zeros read
  // followed by an identical zeros read would satisfy the equality check.
  const reads = [
    snapshot(0, 0, 0, 0, '0.0%'),
    snapshot(0.202, 0.302, 0.218, 0.056, '22.2%'),
    snapshot(0.111, 0.111, 0.111, 0.111, '11.1%'),
    snapshot(0.111, 0.111, 0.111, 0.111, '11.1%'),
  ];
  let i = 0;
  const result = await readUntilStable(fakePage(), async () => reads[i++], { intervalMs: 0, rejectIf: isUnpopulatedSnapshot });
  assert.equal(result.overallRaw, '11.1%');
});
