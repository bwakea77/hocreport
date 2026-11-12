// Fills in days the daily runs missed. Not part of the daily automation.
//
//   node backfillRange.js --from 2026-11-10 --to 2026-11-12          scrape and write
//   node backfillRange.js --from 2026-11-10 --to 2026-11-12 --dry    scrape and print, write nothing
//   add --eaf-only or --eal-only to do one half only
//
// Dates are East Africa Time calendar days and must all be before today.
//
// For each date it does what that date's 05:30 verify run would have done,
// but re-reads the dashboards with explicit Custom Date ranges rather than
// their relative Yesterday/MTD buttons, which by now mean other days:
//
// EAF — GM (daily and MTD) scraped for that date; product metrics computed
// from the raw branch tabs. Rows missing from EAF Data Entry and EAF GM &
// EBITDA Entry are inserted; rows already there are corrected.
//
// EAL (LCC) — the day and 1st-of-month → day ranges re-read. Rows missing
// from EAL Data Entry and EAL GM & EBITDA Entry are inserted; existing ones
// (e.g. a 16:25 EOD run's preliminary row that never got its next-morning
// correction) are corrected.
//
// Inserts skip rows that already exist and corrections never blank a cell, so
// re-running over a date is safe. Corrections do overwrite existing figures
// with the dashboards' current view of that day, though, so give it only the
// days that were missed. DAILY_SNAPSHOT and LCC_SNAPSHOT (single "latest
// state" blocks) are left to the next daily run.
//
// Every scraped figure must come back identical from two independent reads
// before anything is written — these dashboards now and then hand back a
// wrong-but-plausible reading (see backfill.js). A date that can't get two
// agreeing reads after a few tries is skipped and reported, not written
// partially; run it again for that date later.
//
// Generalises the one-off backfillNov2026.js (2026-10-30 → 2026-11-08, after
// the EAL dashboard redesign), which is in git history.
require('dotenv').config();
const config = require('./config');
const { log } = require('./logger');
const { isoDate, eatCalendarDate } = require('./dateUtils');
const { scrapeGm } = require('./scraper');
const { scrapeLccCustomRange, findLccGaps } = require('./lccScraper');
const { getSheetsClient, getBranchRawRows } = require('./sheetsClient');
const { computeBranchDailyMetrics } = require('./metrics');
const { runEalReportsEntry, correctEalValues } = require('./ealReportsEntry');
const { runHocReportsEntry, correctGmValues, correctMetricsValues } = require('./hocReportsEntry');

const USAGE = 'Usage: node backfillRange.js --from YYYY-MM-DD --to YYYY-MM-DD [--dry] [--eaf-only | --eal-only]';

function fail(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

// Local-midnight Date for a YYYY-MM-DD argument, matching how the rest of the
// codebase holds calendar days (see eatCalendarDate in dateUtils.js).
function dayArg(name) {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? '' : process.argv[i + 1] || '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) fail(`${name} needs a date written as YYYY-MM-DD.`);
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isoDate(date) !== value) fail(`${name} ${value} is not a real date.`);
  return date;
}

const DRY = process.argv.includes('--dry');
const DO_EAL = !process.argv.includes('--eaf-only');
const DO_EAF = !process.argv.includes('--eal-only');
if (!DO_EAL && !DO_EAF) fail('--eaf-only and --eal-only together would do nothing.');
const FROM = dayArg('--from');
const TO = dayArg('--to');
if (FROM > TO) fail(`--from ${isoDate(FROM)} is after --to ${isoDate(TO)}.`);
if (TO >= eatCalendarDate(0)) fail(`--to ${isoDate(TO)} is not before today (${isoDate(eatCalendarDate(0))}); today isn't finished yet.`);

const DATES = [];
for (let d = new Date(FROM); d <= TO; d.setDate(d.getDate() + 1)) DATES.push(new Date(d));
const firstOf = (date) => new Date(date.getFullYear(), date.getMonth(), 1);

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
  if (gaps.length) throw new Error(`EAL ${isoDate(date)} scrape has gaps (${gaps.join(', ')}) — not writing.`);
  if (DRY) return;
  const result = await runEalReportsEntry(sheets, date, dateData, mtdData);
  if (result.errors.length) throw new Error(`EAL ${isoDate(date)} insert failed: ${result.errors.join('; ')}`);
  await correctEalValues(sheets, date, dateData, mtdData);
  log(`EAL ${isoDate(date)}: missing rows inserted, existing rows corrected.`);
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
  await correctGmValues(sheets, date, gm);
  await correctMetricsValues(sheets, date, metricsByBranch);
  log(`EAF ${isoDate(date)}: missing rows inserted, existing rows corrected.`);
}

(async () => {
  const halves = DO_EAF && DO_EAL ? 'EAF and EAL' : DO_EAF ? 'EAF only' : 'EAL only';
  log(`Backfill ${isoDate(FROM)}..${isoDate(TO)} (${DATES.length} day(s), ${halves}) starting — ${DRY ? 'DRY RUN, nothing will be written' : 'LIVE, will write to the sheets'}.`);
  const sheets = await getSheetsClient();
  const failures = [];

  if (DO_EAF) {
    const rawByBranch = {};
    for (const { sheetTab } of config.branches) rawByBranch[sheetTab] = await getBranchRawRows(sheets, sheetTab);
    for (const date of DATES) {
      try { await doEaf(sheets, date, rawByBranch); } catch (err) { failures.push(err.message); log(`FAILED: ${err.message}`); }
    }
  }

  if (DO_EAL) {
    for (const date of DATES) {
      try { await doEal(sheets, date); } catch (err) { failures.push(err.message); log(`FAILED: ${err.message}`); }
    }
  }

  if (failures.length) {
    log(`Backfill finished with ${failures.length} failure(s); the other dates are done:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  log(`Backfill complete${DRY ? ' (dry run — nothing written)' : ''}.`);
})().catch((err) => {
  log(`Backfill FAILED: ${err.message}`);
  console.error(err);
  process.exit(1);
});
