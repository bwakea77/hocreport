// One-off repair applying correctMetricsValues (hocReportsEntry.js, added
// 2026-09-13) retroactively across every day from 2026-09-01 through
// 2026-09-12 (the most recent completed day as of this repair). Before that
// date, a branch whose raw-data IMPORTRANGE import hadn't landed by 05:00
// got no second chance if GM happened to be stable at 05:30 (see
// verifyMetricsOnly in index.js) — caught live for DODOMA/KINYEREZI on
// 09-11 and 09-13, but nothing ever re-checked earlier dates for the same
// gap. This re-fetches each branch's raw rows once, recomputes every day in
// range, and corrects any existing EAF Data Entry row whose product lines
// were empty at the time but have data now.
//
//   node backfillMetricsSep.js --dry     recompute and print, write nothing
//   node backfillMetricsSep.js           recompute and write corrections
require('dotenv').config();
const config = require('./config');
const { log } = require('./logger');
const { isoDate } = require('./dateUtils');
const { getBranchRawRows, getSheetsClient } = require('./sheetsClient');
const { computeBranchDailyMetrics } = require('./metrics');
const { correctMetricsValues } = require('./hocReportsEntry');

const DRY = process.argv.includes('--dry');
const START = new Date(2026, 8, 1); // Sep 1
const END = new Date(2026, 8, 12); // Sep 12 — most recent completed day as of this run

function datesBetween(start, end) {
  const out = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(new Date(d));
  }
  return out;
}

(async () => {
  log(`Metrics backfill starting (${DRY ? 'DRY RUN — no writes' : 'LIVE — will write corrections'}) for ${isoDate(START)}..${isoDate(END)}.`);
  const sheets = await getSheetsClient();

  // Each branch's raw tab holds every date's rows already — fetched once per
  // branch here, not once per date, since computeBranchDailyMetrics just
  // filters an already-fetched set down to a given day.
  const rowsByBranch = {};
  for (const { sheetTab } of config.branches) {
    rowsByBranch[sheetTab] = await getBranchRawRows(sheets, sheetTab);
  }

  const summary = [];
  for (const date of datesBetween(START, END)) {
    const metricsByBranch = {};
    for (const { sheetTab } of config.branches) {
      metricsByBranch[sheetTab] = computeBranchDailyMetrics(rowsByBranch[sheetTab], sheetTab, date);
    }
    const counts = config.branches.map((b) => `${b.sheetTab}=${metricsByBranch[b.sheetTab].products.length}`).join(' ');
    const stillEmpty = config.branches.map((b) => b.sheetTab).filter((tab) => metricsByBranch[tab].products.length === 0);
    log(`${isoDate(date)}: ${counts}${stillEmpty.length ? ` | still empty: ${stillEmpty.join(', ')}` : ''}`);

    if (!DRY) {
      const corrected = await correctMetricsValues(sheets, date, metricsByBranch);
      if (corrected.length) {
        log(`  -> corrected: ${corrected.join(', ')}`);
        summary.push(`${isoDate(date)}: ${corrected.join(', ')}`);
      }
    }
  }

  if (!DRY) {
    log(summary.length ? `Metrics backfill complete — corrections applied:\n${summary.join('\n')}` : 'Metrics backfill complete — nothing needed correcting.');
  } else {
    log('Dry run complete — nothing written.');
  }
})().catch((err) => {
  log(`Metrics backfill FAILED: ${err.message}`);
  console.error(err);
  process.exit(1);
});
