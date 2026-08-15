const fs = require('fs');
const path = require('path');
const config = require('./config');
const { log, rotateFileIfNeeded } = require('./logger');
const { isoDate, eatCalendarDate } = require('./dateUtils');
const { scrapeGm, SessionExpiredError } = require('./scraper');
const { scrapeLcc, findLccGaps } = require('./lccScraper');
const { getSheetsClient } = require('./sheetsClient');
const { runDailySnapshot } = require('./dailySnapshot');
const { writeLccYesterdaySnapshot, writeLccTodaySnapshot } = require('./lccSnapshot');
const { runHocReportsEntry, correctGmValues } = require('./hocReportsEntry');
const { runEalReportsEntry, correctEalValues, correctEalDataEntryValues, appendEalDataEntryRows } = require('./ealReportsEntry');
const { saveGmSnapshot, loadGmSnapshot, compareGm } = require('./gmSnapshotStore');
const { saveLccSnapshot, loadLccSnapshot, compareLcc } = require('./lccSnapshotStore');
const { queueAlert, queueSuccessIfClean, flushAlerts } = require('./alert');
const { withRetryOnce } = require('./retry');
const { captureSheetRangeImage, purgeOldDashboardImages, SheetExportAccessError } = require('./sheetImage');
const { uploadImageToSlack } = require('./slackFiles');

// Three cron-triggered runs a day: the primary EAF run at 05:00, a
// verification run at 05:30, and an LCC-only EOD run at 16:25. 05:00/05:30
// exist because of §4.1's known race — the EAF dashboard's "Today" figure
// for yesterday isn't reliably finalized right at 05:00, so 05:30 re-scrapes
// and corrects anything that moved in the meantime, rather than pushing the
// primary run later and delaying everyone who reads DAILY_SNAPSHOT right
// after it. 16:25 exists because the LCC (Transport P&L) dashboard has its
// own same-day "Today" view, worth reading again once most of the business
// day's activity has posted, separate from the two EAF runs above. As of
// 2026-08-15, 16:25 also writes a same-day preliminary row into EAL Data
// Entry (partial-day figures) — the next morning's 05:00 run always
// overwrites that date's EAL Data Entry values with its finalized scrape
// (see the correction call in runLccPrimary), so the preliminary figures
// never linger past the following morning.
const isEodRun = process.argv.includes('--eod');
const isVerifyRun = process.argv.includes('--verify');
const RUN_LABEL = isEodRun ? '1625' : isVerifyRun ? '0530' : '0500';

const LOCK_PATH = path.join(__dirname, 'run.lock');

// No legitimate run — scraping, Sheets writes, and a Slack alert flush all
// included — takes anywhere near this long. Guards against process.kill's
// liveness check false-positiving on a reused pid: if the OS has recycled
// the held pid onto some unrelated process by the time we check, kill(pid,0)
// reports "alive" even though the run that created this lock is long gone.
// An age check here catches that case; a pid check alone can't.
const STALE_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// Prevents two runs from clearing/rewriting DAILY_SNAPSHOT concurrently if a
// prior run is still in progress (e.g. hung) when cron fires again. A lock
// held by a pid that's no longer running — or one alive but implausibly old,
// see STALE_LOCK_MAX_AGE_MS above — is treated as stale and reclaimed.
function acquireLock() {
  // 'wx' creates the file atomically iff it doesn't already exist, closing
  // the check-then-write race a plain existsSync()+writeFileSync() has
  // between two near-simultaneous cron fires.
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
    return;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const heldPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
  let alive = false;
  if (!Number.isNaN(heldPid)) {
    try {
      process.kill(heldPid, 0);
      alive = true;
    } catch (err) {
      // ESRCH means no process with this pid exists at all — genuinely dead.
      // Any other error (most notably EPERM: a process with this pid exists
      // but is owned by a different user) means we can't confirm it's dead,
      // so default to "alive" rather than reclaim a lock that might still be
      // legitimately held — the STALE_LOCK_MAX_AGE_MS check below still
      // reclaims it if it's implausibly old regardless.
      if (err.code === 'ESRCH') {
        alive = false;
      } else {
        alive = true;
        log(`Lock file pid ${heldPid}: liveness check failed with ${err.code || err.message} (not ESRCH) — can't confirm it's dead, conservatively treating as alive.`);
      }
    }
  }

  let staleReason = 'is not running';
  if (alive) {
    const lockAgeMs = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
    if (lockAgeMs > STALE_LOCK_MAX_AGE_MS) {
      staleReason = `is alive but the lock is ${Math.round(lockAgeMs / 60000)}min old — older than any legitimate run should ever take, so this is almost certainly a reused pid rather than a real still-running instance`;
      alive = false;
    }
  }

  if (alive) {
    throw new Error(`Another run (pid ${heldPid}) appears to be in progress (${LOCK_PATH} exists); aborting.`);
  }
  log(`Lock file pid ${heldPid} ${staleReason} — treating as stale and reclaiming.`);

  // Reclaim via unlink + 'wx' rather than a plain overwrite: if another
  // process is reclaiming the same stale lock at the same instant, only one
  // of us wins the 'wx' create; the loser gets EEXIST and aborts below
  // instead of both proceeding to write DAILY_SNAPSHOT concurrently.
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(`Lost the race to reclaim a stale lock (${LOCK_PATH}); another run just started. Aborting.`);
    }
    throw err;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_PATH) && fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch (err) {
    log(`Failed to release lock file: ${err.message}`);
  }
}

async function writeEverything(sheets, targetDate, gmByBranch) {
  const diagnostics = await withRetryOnce('DAILY_SNAPSHOT write', () => runDailySnapshot(sheets, targetDate, gmByBranch));
  const hocReportsResult = await runHocReportsEntry(sheets, targetDate, diagnostics.metricsByBranch, gmByBranch);
  return { diagnostics, hocReportsResult };
}

async function alertOnGaps(diagnostics, hocReportsResult) {
  const { emptyRawBranches, missingGm, allBranchesZeroProducts, zeroProductBranches, columnLayoutBranches } = diagnostics;
  const parts = [];
  if (emptyRawBranches.length) parts.push(`no raw rows fetched for: ${emptyRawBranches.join(', ')}`);
  if (missingGm.length) parts.push(`GM missing/unparseable for: ${missingGm.join(', ')}`);
  if (allBranchesZeroProducts) {
    parts.push(`no rows matched target date for ANY branch — upstream data for this date may not have landed yet`);
  } else if (zeroProductBranches.length) {
    parts.push(`no rows matched target date for: ${zeroProductBranches.join(', ')}`);
  }
  if (columnLayoutBranches.length) parts.push(`raw column layout may have shifted for: ${columnLayoutBranches.join(', ')}`);
  if (hocReportsResult.errors.length) parts.push(`HOC-REPORTS-final write failed — ${hocReportsResult.errors.join('; ')}`);
  if (!parts.length) return;
  const warning = `⚠️ [${RUN_LABEL}] Run completed with gaps — ${parts.join('; ')}.`;
  log(`Degraded run: ${warning}`);
  queueAlert(`${warning} (${new Date().toISOString()})`);
}

// Mirrors alertOnGaps above, for LCC. readKpiAndChannel (lccScraper.js) logs
// and nulls a field rather than throwing when its regex fails to match — a
// page-structure change on one KPI card shouldn't abort a scrape that
// otherwise mostly succeeded — so nothing upstream of this previously
// noticed a partial read; it just wrote dashes and logged "written" like
// any successful run. findLccGaps surfaces exactly what's missing so it
// gets the same Slack-alert treatment EAF gaps already get.
async function alertOnLccGaps(label, data) {
  const gaps = findLccGaps(data);
  if (!gaps.length) return;
  const warning = `⚠️ [${RUN_LABEL}] LCC ${label} view completed with gaps — missing/unparseable: ${gaps.join(', ')}.`;
  log(`Degraded LCC run: ${warning}`);
  queueAlert(`${warning} (${new Date().toISOString()})`);
}

async function alertLccFailure(err) {
  log(`LCC scrape/write failed: ${err.message}`);
  const message =
    err instanceof SessionExpiredError
      ? `⚠️ [${RUN_LABEL}] LCC scrape failed — session expired, run scripts/captureLccSession.js to relink.`
      : `⚠️ [${RUN_LABEL}] LCC scrape/write failed: ${err.message}`;
  queueAlert(`${message} (${new Date().toISOString()})`);
}

// Scrapes the LCC (Transport P&L) dashboard's "Yesterday" AND "MTD" views
// for targetDate. Shared by the primary (05:00) and verify (05:30) runs —
// the scrape+parse step is identical between them; only what happens with
// the result (save as baseline vs. compare against it) differs.
async function scrapeLccMorningData(targetDate) {
  const dateData = await scrapeLcc('Yesterday', targetDate, `LCC-${RUN_LABEL}`);
  const mtdData = await scrapeLcc('MTD', targetDate, `LCC-${RUN_LABEL}-MTD`);
  return { dateData, mtdData };
}

// Writes yesterday's LCC figures into EAL Data Entry + EAL GM & EBITDA Entry
// (mirrors EAF Data Entry / EAF GM & EBITDA Entry's roles for the EAF side)
// — best-effort: runEalReportsEntry catches its own errors, so a sheet-write
// hiccup here surfaces as its own alert rather than being folded into a
// generic "LCC scrape/write failed" message or aborting the LCC_SNAPSHOT
// write that already succeeded.
async function writeEalReportsEntry(sheets, targetDate, dateData, mtdData) {
  const ealResult = await runEalReportsEntry(sheets, targetDate, dateData, mtdData);
  if (ealResult.errors.length) {
    const warning = `⚠️ [${RUN_LABEL}] EAL Data Entry write failed — ${ealResult.errors.join('; ')}.`;
    log(warning);
    queueAlert(`${warning} (${new Date().toISOString()})`);
  }
}

// 05:00 — scrapes and writes LCC Yesterday/MTD unconditionally, then saves
// the figures as the baseline runLccVerify compares against at 05:30.
// Wrapped in its own try/catch so an LCC-side failure (site down, session
// expired) never takes down the EAF run that already succeeded — it only
// alerts separately.
async function runLccPrimary(sheets, targetDate) {
  try {
    const { dateData, mtdData } = await scrapeLccMorningData(targetDate);
    await writeLccYesterdaySnapshot(sheets, targetDate, dateData, mtdData);
    saveLccSnapshot(targetDate, { dateData, mtdData });
    log('LCC_SNAPSHOT (Yesterday + MTD) written.');
    await writeEalReportsEntry(sheets, targetDate, dateData, mtdData);
    // Unconditional correction on top of the insert-if-missing write above —
    // covers the common case where yesterday's 16:25 EOD run already
    // inserted a same-day preliminary row for targetDate from a partial
    // "Today" scrape, which the insert step just skipped as "already
    // exists." This morning's finalized "Yesterday" scrape must win over
    // that partial figure, so it's applied unconditionally rather than only
    // when a diff is detected (no preliminary row means this just re-writes
    // the values the insert above wrote a moment ago — harmless).
    await correctEalDataEntryValues(sheets, targetDate, dateData);
    await alertOnLccGaps('Yesterday', dateData);
    await alertOnLccGaps('MTD', mtdData);
  } catch (err) {
    await alertLccFailure(err);
  }
}

// 05:30 — re-scrapes LCC and compares against the 05:00 baseline, the same
// same-day finalization race §4.1 describes for EAF's GM (the LCC dashboard
// can just as plausibly still be settling shortly after midnight). If
// nothing moved, this is a no-op. Runs independently of whether the EAF GM
// verification found anything to correct — previously this only ran at all
// when GM had moved, meaning LCC never got its own re-check on days GM
// happened to be stable.
async function runLccVerify(sheets, targetDate) {
  try {
    const { dateData, mtdData } = await scrapeLccMorningData(targetDate);
    const previous = loadLccSnapshot(targetDate);
    let diffs = null;

    if (previous === null) {
      log('No 05:00 LCC baseline found for this date (missing or failed) — writing 05:30 figures as primary.');
    } else {
      diffs = compareLcc(previous, { dateData, mtdData });
      if (!diffs.length) {
        log('LCC stable between 05:00 and 05:30 runs — nothing to correct.');
        await alertOnLccGaps('Yesterday', dateData);
        await alertOnLccGaps('MTD', mtdData);
        return;
      }
      log(`LCC changed between 05:00 and 05:30 runs: ${diffs.join('; ')}`);
    }

    await writeLccYesterdaySnapshot(sheets, targetDate, dateData, mtdData);
    saveLccSnapshot(targetDate, { dateData, mtdData });

    // insert-if-missing (covers "05:00 never ran") then correct-if-existing
    // (covers "05:00 ran but numbers moved") — same two-step pattern as
    // writeAndCorrectGm uses for EAF Data Entry.
    await writeEalReportsEntry(sheets, targetDate, dateData, mtdData);
    await correctEalValues(sheets, targetDate, dateData, mtdData);

    const correctionNote =
      previous === null
        ? 'no 05:00 LCC baseline existed — 05:30 figures written as primary'
        : `LCC corrected vs 05:00 run — ${diffs.join('; ')}`;
    log(`⚠️ ${correctionNote}`);
    queueAlert(`⚠️ [0530] ${correctionNote} (${new Date().toISOString()})`);

    await alertOnLccGaps('Yesterday', dateData);
    await alertOnLccGaps('MTD', mtdData);
  } catch (err) {
    await alertLccFailure(err);
  }
}

async function writeAndCorrectGm(sheets, targetDate, gmByBranch, correctionNote) {
  const { diagnostics, hocReportsResult } = await writeEverything(sheets, targetDate, gmByBranch);
  // correctGmValues retries its own write internally (see manualEntryRows'
  // collectCellUpdate/applyBatchUpdate usage there) — not wrapped again here.
  await correctGmValues(sheets, targetDate, gmByBranch);
  log(`⚠️ ${correctionNote}`);
  queueAlert(`⚠️ [0530] ${correctionNote} (${new Date().toISOString()})`);
  await alertOnGaps(diagnostics, hocReportsResult);
}

// 05:00 — the primary run. Unchanged behavior, plus persisting the scraped
// GM figures so the 05:30 run has a baseline to check against.
async function runPrimary(targetDate) {
  // Session-expired / unreachable-site errors surface here and abort before
  // any write happens, so partial/stale data is never written (§5.3).
  const gmByBranch = await scrapeGm(targetDate, RUN_LABEL);
  saveGmSnapshot(targetDate, gmByBranch);

  const sheets = await getSheetsClient();
  const { diagnostics, hocReportsResult } = await writeEverything(sheets, targetDate, gmByBranch);
  log('Run succeeded — DAILY_SNAPSHOT written.');
  await alertOnGaps(diagnostics, hocReportsResult);

  await runLccPrimary(sheets, targetDate);

  await captureAndPostDashboardImages(sheets, config.sheetImages.targets.morning, targetDate);
}

// 05:30 — re-scrapes and compares against the 05:00 snapshot (§4.1: the
// dashboard isn't reliably finalized right at 05:00). GM and LCC are
// verified independently of each other — if GM is stable, only LCC's own
// comparison runs; if GM moved, or there's no 05:00 baseline at all, the
// 05:30 GM figures are treated as the more finalized ones and overwrite
// what's already in both spreadsheets. LCC's own verification (runLccVerify)
// always runs regardless of what GM did.
async function runVerify(targetDate) {
  const gmByBranch = await scrapeGm(targetDate, RUN_LABEL);
  const previousGm = loadGmSnapshot(targetDate);
  const sheets = await getSheetsClient();

  if (previousGm === null) {
    log('No 05:00 baseline found for this date (missing or failed) — writing 05:30 figures as primary.');
    await writeAndCorrectGm(sheets, targetDate, gmByBranch, 'no 05:00 baseline existed — 05:30 figures written as primary');
  } else {
    const diffs = compareGm(previousGm, gmByBranch);
    if (diffs.length) {
      log(`GM changed between 05:00 and 05:30 runs: ${diffs.join('; ')}`);
      await writeAndCorrectGm(sheets, targetDate, gmByBranch, `GM corrected vs 05:00 run — ${diffs.join('; ')}`);
    } else {
      log('GM stable between 05:00 and 05:30 runs — nothing to correct.');
    }
  }

  await runLccVerify(sheets, targetDate);

  await captureAndPostDashboardImages(sheets, config.sheetImages.targets.morning, targetDate);
}

// Lets any cross-sheet lookups on the dashboard tabs below (e.g. the EAF
// tab's K22 exact-date lookup into HOC-REPORTS-final's EAF Data Entry, a
// SEPARATE spreadsheet — see hocReportsEntry.js) catch up before
// screenshotting. IMPORTRANGE-backed formulas don't recalculate on the same
// tight schedule as same-spreadsheet formulas; opening the sheet in an actual
// browser (which capturing the screenshot below already does) is itself one
// of the known triggers for IMPORTRANGE to refresh, but this pipeline hasn't
// been run against these dashboard tabs long enough to confirm that always
// lands in time — if a posted image looks stale, this is the first thing to
// widen.
const SHEET_IMAGE_SETTLE_DELAY_MS = 5000;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Screenshots each configured {tab, range} dashboard target (config.js's
// sheetImages.targets) and posts it to Slack as an image, in the same run
// that already sends the text notification. Best-effort per target: one
// tab's screenshot/upload failing (stale/expired Google session, a renamed
// tab, a Slack API hiccup) is logged and surfaced as its own Slack TEXT
// warning via the existing webhook — it never blocks another target in the
// same run, and never fails the run itself, since the underlying data write
// this is meant to illustrate has already succeeded by the time this runs.
async function captureAndPostDashboardImages(sheets, targets, targetDate) {
  if (!targets || !targets.length) return;
  fs.mkdirSync(config.sheetImages.outputDir, { recursive: true });
  purgeOldDashboardImages(config.sheetImages.outputDir);
  await sleep(SHEET_IMAGE_SETTLE_DELAY_MS);

  for (const target of targets) {
    const spreadsheetId = target.spreadsheetId || config.sheets.spreadsheetId;
    const outputPath = path.join(
      config.sheetImages.outputDir,
      `${isoDate(targetDate)}_${RUN_LABEL}_${target.tab}.png`
    );
    try {
      await withRetryOnce(`Dashboard image capture for ${target.tab}!${target.range}`, async () => {
        await captureSheetRangeImage(sheets, { spreadsheetId, tab: target.tab, range: target.range }, outputPath);
        await uploadImageToSlack(outputPath, {
          title: `${target.tab} (${RUN_LABEL})`,
          comment: `📊 [${RUN_LABEL}] ${target.tab}!${target.range} — ${isoDate(targetDate)}`,
        });
      });
      log(`Dashboard image: captured and posted ${target.tab}!${target.range}.`);
    } catch (err) {
      const message =
        err instanceof SheetExportAccessError
          ? `⚠️ [${RUN_LABEL}] Dashboard image capture denied for ${target.tab}!${target.range} — confirm the sheets-writer service account has Viewer+ access to ${spreadsheetId}: ${err.message}`
          : `⚠️ [${RUN_LABEL}] Dashboard image capture failed for ${target.tab}!${target.range}: ${err.message}`;
      log(message);
      queueAlert(`${message} (${new Date().toISOString()})`);
    }
  }
}

// Best-effort, like writeEalReportsEntry above — a write hiccup here
// surfaces as its own alert rather than aborting the LCC_SNAPSHOT write that
// already succeeded. Only touches EAL Data Entry (not EAL GM & EBITDA
// Entry): the EOD run only scrapes a single day ("Today"), not an MTD range,
// so there's no MTD figure to write into the GM & EBITDA tab's row here.
async function writeEalDataEntryPreliminary(sheets, today, data) {
  try {
    await withRetryOnce('ealReportsEntry: EAL Data Entry preliminary write', () =>
      appendEalDataEntryRows(sheets, today, data)
    );
  } catch (err) {
    const warning = `⚠️ [${RUN_LABEL}] EAL Data Entry preliminary write failed — ${err.message}.`;
    log(warning);
    queueAlert(`${warning} (${new Date().toISOString()})`);
  }
}

// 16:25 — LCC-only EOD run. Reads the LCC dashboard's "Today" view (today's
// activity so far, EAT calendar day) and writes it to LCC_SNAPSHOT's Today
// block, plus a same-day preliminary row into EAL Data Entry from the same
// partial-day figures (tomorrow's 05:00 run always overwrites that row with
// its finalized scrape — see the correction call in runLccPrimary).
// Otherwise independent of the EAF/DAILY_SNAPSHOT pipeline entirely — no EAF
// scrape, no other HOC-REPORTS-final write.
async function runEod() {
  const today = eatCalendarDate(0);
  log(`Run started (${RUN_LABEL}). Target date = ${today.toDateString()}`);

  const data = await scrapeLcc('Today', today, `LCC-${RUN_LABEL}`);
  const sheets = await getSheetsClient();
  await writeLccTodaySnapshot(sheets, today, data);
  log('LCC_SNAPSHOT (Today/EOD) written.');
  await writeEalDataEntryPreliminary(sheets, today, data);
  await alertOnLccGaps('Today', data);

  await captureAndPostDashboardImages(sheets, config.sheetImages.targets.eod, today);
}

// cron.log (see README's crontab recipe) has no rotation of its own, unlike
// run.log above — apply the same size-based policy to it here since it's a
// fixed, known path relative to this file regardless of cron's cwd.
const CRON_LOG_PATH = path.join(__dirname, 'cron.log');

async function run() {
  rotateFileIfNeeded(CRON_LOG_PATH);
  acquireLock();

  if (isEodRun) {
    await runEod();
    return;
  }

  const targetDate = eatCalendarDate(1);
  log(`Run started (${RUN_LABEL}). Target date = ${targetDate.toDateString()}`);

  if (isVerifyRun) {
    await runVerify(targetDate);
  } else {
    await runPrimary(targetDate);
  }
}

run()
  .then(async () => {
    // Every run posts exactly one Slack message when it completes cleanly —
    // if a gap/correction warning already fired above, this is a no-op (see
    // queueSuccessIfClean); otherwise it's the only signal in Slack that the
    // run happened at all and found nothing to report.
    queueSuccessIfClean(`✅ [${RUN_LABEL}] Run completed successfully. (${new Date().toISOString()})`);
    try {
      await flushAlerts();
    } catch (alertErr) {
      log(`Failed to send queued Slack alert(s): ${alertErr.message}`);
    }
    releaseLock();
    process.exit(0);
  })
  .catch(async (err) => {
    log(`Run FAILED (${RUN_LABEL}): ${err.message}`);
    // isEodRun never scrapes EAF, so any SessionExpiredError reaching this
    // top-level handler in that mode can only have come from the LCC
    // scraper — safe to attribute without the two sharing a distinguishing
    // subclass. During primary/verify runs, LCC failures are already caught
    // and alerted inside runLccPrimary/runLccVerify and never reach here.
    const message = isEodRun
      ? err instanceof SessionExpiredError
        ? `❌ [${RUN_LABEL}] LCC scrape failed — session expired, run scripts/captureLccSession.js to relink.`
        : `❌ [${RUN_LABEL}] LCC EOD scrape/write pipeline failed: ${err.message}`
      : err instanceof SessionExpiredError
        ? `❌ [${RUN_LABEL}] GM scrape failed — EAF session expired, run scripts/captureEafSession.js to relink.`
        : `❌ [${RUN_LABEL}] GM scrape/write pipeline failed: ${err.message}`;
    queueAlert(`${message} (${new Date().toISOString()})`);
    try {
      await flushAlerts();
    } catch (alertErr) {
      log(`Failed to send queued Slack alert(s): ${alertErr.message}`);
    }
    releaseLock();
    process.exit(1);
  });
