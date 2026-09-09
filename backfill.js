// One-off repair for the 2026-09-08 EAL outage and the two EAF MTD GM cells
// the verify run zeroed. Not part of the daily automation.
//
//   node backfill.js --dry     scrape and print, write nothing
//   node backfill.js           scrape and write
//
// What it repairs:
//
// EAL (LCC), 2026-09-07 and -08 — the LCC session expired overnight
// 09-07→08, so the 09-08 and 09-09 morning runs and the 09-08 EOD run all
// failed. 09-07 kept the preliminary row its own 16:25 EOD run inserted but
// never got the next-morning correction or its EAL GM & EBITDA row; 09-08
// got nothing at all. Both dates are re-scraped with explicit custom ranges
// (scrapeLccCustomRange) rather than the daily automation's relative
// Yesterday/MTD period buttons, which now mean the wrong days.
//
// EAF MTD GM, 2026-08-31 and 2026-09-05 — on 09-01 and 09-06 the 05:30
// verify run read the dashboard's all-zeros placeholder and wrote 0.0% over
// the correct MTD GM the 05:00 run had already recorded (see
// isUnpopulatedSnapshot in scraper.js, which is the fix that stops it
// recurring). Re-scraped from the dashboard rather than recovered from the
// 05:00 log lines, which are rounded to one decimal.
require('dotenv').config();
const config = require('./config');
const { log } = require('./logger');
const { isoDate } = require('./dateUtils');
const { scrapeGm } = require('./scraper');
const { scrapeLccCustomRange, findLccGaps } = require('./lccScraper');
const { getSheetsClient } = require('./sheetsClient');
const { writeLccYesterdaySnapshot } = require('./lccSnapshot');
const { runEalReportsEntry, correctEalValues } = require('./ealReportsEntry');
const { correctGmValues } = require('./hocReportsEntry');

const DRY = process.argv.includes('--dry');
const d = (y, m, day) => new Date(y, m - 1, day);
const firstOf = (date) => new Date(date.getFullYear(), date.getMonth(), 1);

const EAL_DATES = [d(2026, 9, 7), d(2026, 9, 8)];
const EAF_MTD_DATES = [d(2026, 8, 31), d(2026, 9, 5)];

// Every figure written below has to come back identical from two independent
// scrapes. These dashboards demonstrably hand back a wrong-but-plausible
// reading now and then — on 2026-09-09 a read of the 01 Aug - 31 Aug range
// returned the default "today" view's numbers, and an immediate re-run of the
// same call returned the correct ones. rejectSnapshot (scraper.js) now catches
// that specific case in the daily pipeline, but this is a one-off write of
// historical figures that nothing downstream will ever re-verify, so it does
// not lean on a guard written the same afternoon.
async function twice(label, read) {
  const a = await read();
  const b = await read();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error(`  read 1: ${JSON.stringify(a)}`);
    console.error(`  read 2: ${JSON.stringify(b)}`);
    throw new Error(`${label}: two scrapes disagreed — refusing to write. Re-run; if it persists, the dashboard is unstable for this range.`);
  }
  return a;
}

async function scrapeEal(date) {
  const dateData = await twice(`EAL ${isoDate(date)} day`, () => scrapeLccCustomRange(date, date, null));
  const mtdData = await twice(`EAL ${isoDate(date)} MTD`, () => scrapeLccCustomRange(firstOf(date), date, null));
  return { dateData, mtdData };
}

(async () => {
  log(`Backfill starting (${DRY ? 'DRY RUN — no writes' : 'LIVE — will write to sheets'}).`);

  // Scrape everything first, so a failure part-way through leaves the sheets
  // untouched rather than half-repaired.
  const eal = [];
  for (const date of EAL_DATES) {
    const { dateData, mtdData } = await scrapeEal(date);
    const gaps = [...findLccGaps(dateData), ...findLccGaps(mtdData)];
    log(`EAL ${isoDate(date)}: rev=${dateData.revenue.actual} gm=${dateData.grossMargin.actual} ebitda=${dateData.ebitda.actual} | mtd rev=${mtdData.revenue.actual} gm=${mtdData.grossMargin.actual}${gaps.length ? ` | GAPS: ${gaps.join(', ')}` : ''}`);
    console.log(`  ${isoDate(date)} dateData:`, JSON.stringify(dateData));
    console.log(`  ${isoDate(date)} mtdData :`, JSON.stringify(mtdData));
    if (gaps.length) throw new Error(`EAL ${isoDate(date)} scrape has gaps (${gaps.join(', ')}) — refusing to write a partial repair.`);
    eal.push({ date, dateData, mtdData });
  }

  const eaf = [];
  for (const date of EAF_MTD_DATES) {
    const gm = await twice(`EAF ${isoDate(date)} GM`, () => scrapeGm(date, null));
    // Only the MTD column was corrupted; the daily column was written from a
    // stable read and is correct. Nulling daily makes collectCellUpdate skip
    // it (manualEntryRows.js), so this repair touches column C only.
    const mtdOnly = {};
    for (const key of Object.keys(gm)) mtdOnly[key] = { daily: null, mtd: gm[key].mtd };
    log(`EAF ${isoDate(date)} MTD GM: ${Object.entries(mtdOnly).map(([k, v]) => `${k}=${v.mtd === null ? '-' : (v.mtd * 100).toFixed(1) + '%'}`).join(' ')}`);
    if (Object.values(mtdOnly).every((v) => v.mtd === null || v.mtd === 0)) {
      throw new Error(`EAF ${isoDate(date)} MTD re-scrape came back all-zero/empty — refusing to re-write the same placeholder.`);
    }
    eaf.push({ date, mtdOnly });
  }

  if (DRY) {
    log('Dry run complete — nothing written.');
    return;
  }

  const sheets = await getSheetsClient();

  for (const { date, dateData, mtdData } of eal) {
    // Same two steps the 05:00 run does: insert-if-missing, then correct the
    // rows that already exist (09-07's preliminary EOD row).
    const result = await runEalReportsEntry(sheets, date, dateData, mtdData);
    if (result.errors.length) throw new Error(`EAL ${isoDate(date)} write failed: ${result.errors.join('; ')}`);
    await correctEalValues(sheets, date, dateData, mtdData);
    log(`EAL ${isoDate(date)}: entry rows written and corrected.`);
  }

  // LCC_SNAPSHOT is a single "latest state" block, not per-date history —
  // write it once, from the most recent date backfilled.
  const latest = eal[eal.length - 1];
  await writeLccYesterdaySnapshot(sheets, latest.date, latest.dateData, latest.mtdData);
  log(`LCC_SNAPSHOT (Yesterday + MTD) refreshed from ${isoDate(latest.date)}.`);

  for (const { date, mtdOnly } of eaf) {
    await correctGmValues(sheets, date, mtdOnly);
    log(`EAF ${isoDate(date)}: MTD GM restored.`);
  }

  log('Backfill complete.');
})().catch((err) => {
  log(`Backfill FAILED: ${err.message}`);
  console.error(err);
  process.exit(1);
});
