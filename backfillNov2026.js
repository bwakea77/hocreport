// One-off repair for 2026-10-30 → 2026-11-08. Not part of the daily automation.
//
//   node backfillNov2026.js --dry        scrape and print, write nothing
//   node backfillNov2026.js              scrape and write
//   node backfillNov2026.js --eal-only   / --eaf-only   one half only
//
// What it repairs:
//
// EAL (LCC) — the EAL dashboard was redesigned around 2026-10-31 16:25 (KPI
// cards' "A:" became "Actual", revenue card now rounded) and every LCC read
// since failed to parse revenue / GM / EBITDA (fixed in lccScraper.js's
// readKpiAndChannel). Rows for 2026-11-02..06 exist with channel figures but
// blank Overall GM/EBITDA; 10-31, 11-01, 11-07, 11-08 rows (and 10-30's
// EAL GM & EBITDA rows) are missing from the sheet altogether — the log shows
// they were inserted, so they were removed after the fact. Each date is
// re-read via explicit Custom Date ranges (day, and 1st-of-month → day for
// MTD), then insert-if-missing + correct-existing, same as the 05:30 verify.
//
// EAF — 2026-11-07 and -08 rows were inserted by the 05:00 runs (and
// confirmed present by the 06:55 catchup on 11-09) but are gone from both
// EAF entry tabs. Re-inserted from a fresh GM scrape of that date plus
// metrics computed from the raw branch tabs. DAILY_SNAPSHOT and
// LCC_SNAPSHOT (single "latest state" blocks) are not touched by the EAF
// half; LCC_SNAPSHOT is refreshed from the most recent EAL date, as the
// 05:00 run would have done with a working parser.
//
// Every scraped figure must come back identical from two independent reads
// before anything is written (same guard as backfill.js). A date that can't
// get two agreeing reads after a few tries is skipped and reported, not
// written partially.
require('dotenv').config();
const config = require('./config');
const { log } = require('./logger');
const { isoDate } = require('./dateUtils');
const { scrapeGm } = require('./scraper');
const { scrapeLccCustomRange, findLccGaps } = require('./lccScraper');
const { getSheetsClient, getBranchRawRows } = require('./sheetsClient');
const { computeBranchDailyMetrics } = require('./metrics');
const { writeLccYesterdaySnapshot } = require('./lccSnapshot');
const { runEalReportsEntry, correctEalValues } = require('./ealReportsEntry');
const { runHocReportsEntry } = require('./hocReportsEntry');

const DRY = process.argv.includes('--dry');
const DO_EAL = !process.argv.includes('--eaf-only');
const DO_EAF = !process.argv.includes('--eal-only');
const d = (y, m, day) => new Date(y, m - 1, day);
const firstOf = (date) => new Date(date.getFullYear(), date.getMonth(), 1);

const EAL_DATES = [d(2026, 10, 30), d(2026, 10, 31), ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => d(2026, 11, n))];
const EAF_DATES = [d(2026, 11, 7), d(2026, 11, 8)];

async function agreed(label, read, tries = 3) {
  let last;
  for (let t = 1; t <= tries; t++) {
    const a = await read();
    const b = await read();
    if (JSON.stringify(a) === JSON.stringify(b)) return a;
    last = `read 1: ${JSON.stringify(a)} | read 2: ${JSON.stringify(b)}`;
    log(`${label}: two reads disagreed (try ${t}/${tries}) — ${last}`);
  }
  throw new Error(`${label}: reads never agreed. Last pair — ${last}`);
}

async function doEal(sheets, date) {
  const dateData = await agreed(`EAL ${isoDate(date)} day`, () => scrapeLccCustomRange(date, date, null));
  const mtdData = await agreed(`EAL ${isoDate(date)} MTD`, () => scrapeLccCustomRange(firstOf(date), date, null));
  const gaps = [...findLccGaps(dateData), ...findLccGaps(mtdData)];
  log(`EAL ${isoDate(date)}: rev=${dateData.revenue.actual} gm=${dateData.grossMargin.actual} ebitda=${dateData.ebitda.actual} | mtd rev=${mtdData.revenue.actual} gm=${mtdData.grossMargin.actual} ebitda=${mtdData.ebitda.actual}`);
  console.log(`  dateData: ${JSON.stringify(dateData)}`);
  console.log(`  mtdData : ${JSON.stringify(mtdData)}`);
  if (gaps.length) throw new Error(`EAL ${isoDate(date)} scrape has gaps (${gaps.join(', ')}) — not writing.`);
  if (DRY) return { date, dateData, mtdData };
  const result = await runEalReportsEntry(sheets, date, dateData, mtdData);
  if (result.errors.length) throw new Error(`EAL ${isoDate(date)} insert failed: ${result.errors.join('; ')}`);
  await correctEalValues(sheets, date, dateData, mtdData);
  log(`EAL ${isoDate(date)}: written and corrected.`);
  return { date, dateData, mtdData };
}

async function doEaf(sheets, date, rawByBranch) {
  const gm = await agreed(`EAF ${isoDate(date)} GM`, () => scrapeGm(date, null));
  const metricsByBranch = {};
  for (const { sheetTab } of config.branches) {
    metricsByBranch[sheetTab] = computeBranchDailyMetrics(rawByBranch[sheetTab], sheetTab, date);
  }
  const counts = config.branches.map((b) => `${b.sheetTab}=${metricsByBranch[b.sheetTab].products.length}`).join(' ');
  const gmLine = Object.entries(gm).map(([k, v]) => `${k}=${v.daily === null ? '-' : (v.daily * 100).toFixed(1) + '%'}/${v.mtd === null ? '-' : (v.mtd * 100).toFixed(1) + '%'}`).join(' ');
  log(`EAF ${isoDate(date)}: GM daily/mtd ${gmLine} | product lines ${counts}`);
  if (Object.values(gm).every((v) => !v || ((v.daily === null || v.daily === 0) && (v.mtd === null || v.mtd === 0)))) {
    throw new Error(`EAF ${isoDate(date)} GM came back all-zero/empty — not writing.`);
  }
  if (DRY) return;
  const result = await runHocReportsEntry(sheets, date, metricsByBranch, gm);
  if (result.errors.length) throw new Error(`EAF ${isoDate(date)} write failed: ${result.errors.join('; ')}`);
  log(`EAF ${isoDate(date)}: rows written.`);
}

(async () => {
  log(`Nov-2026 backfill starting (${DRY ? 'DRY RUN — no writes' : 'LIVE — will write to sheets'}).`);
  const sheets = await getSheetsClient();
  const failures = [];

  if (DO_EAF) {
    const rawByBranch = {};
    for (const { sheetTab } of config.branches) rawByBranch[sheetTab] = await getBranchRawRows(sheets, sheetTab);
    for (const date of EAF_DATES) {
      try { await doEaf(sheets, date, rawByBranch); } catch (err) { failures.push(err.message); log(`FAILED: ${err.message}`); }
    }
  }

  let latestEal = null;
  if (DO_EAL) {
    for (const date of EAL_DATES) {
      try { latestEal = await doEal(sheets, date); } catch (err) { failures.push(err.message); log(`FAILED: ${err.message}`); }
    }
    if (!DRY && latestEal && isoDate(latestEal.date) === isoDate(EAL_DATES[EAL_DATES.length - 1])) {
      await writeLccYesterdaySnapshot(sheets, latestEal.date, latestEal.dateData, latestEal.mtdData);
      log(`LCC_SNAPSHOT (Yesterday + MTD) refreshed from ${isoDate(latestEal.date)}.`);
    }
  }

  if (failures.length) {
    log(`Nov-2026 backfill finished with ${failures.length} failure(s):\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  log(`Nov-2026 backfill complete${DRY ? ' (dry run — nothing written)' : ''}.`);
})().catch((err) => {
  log(`Nov-2026 backfill FAILED: ${err.message}`);
  console.error(err);
  process.exit(1);
});
