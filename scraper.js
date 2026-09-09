const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config');
const { log } = require('./logger');
const { captureEvidence } = require('./evidence');
const { waitForDashboardOrLogin } = require('./dashboardReady');
const { captureSession } = require('./sessionCapture');

class SessionExpiredError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePercent(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed === '—' || trimmed === '-') return null;
  const num = parseFloat(trimmed.replace('%', ''));
  if (Number.isNaN(num)) return null;
  return num / 100;
}

async function scrapeGmForCurrentView(page) {
  const { branchTableRows, gmCellIndexInRow, branchNameCellIndexInRow } = config.eaf.selectors;
  const values = {};

  // Reads every row's branch-name cell once and matches on exact (trimmed)
  // text, rather than Playwright's hasText substring match against the
  // whole row — a substring match would silently mismatch if a future
  // branch name were ever a substring of another's (e.g. "Onja" vs. some
  // later "Onja West"), matching the wrong row with no warning since count
  // would still come back as 1.
  const rowLocator = page.locator(branchTableRows);
  const rowCount = await rowLocator.count();
  const rowBranchNames = [];
  for (let i = 0; i < rowCount; i++) {
    let name = '';
    // Check the row actually has a branch-name cell before trying to read
    // one, rather than spending a 5s timeout per row discovering it doesn't.
    // While the table is still rendering it carries a batch of skeleton rows
    // with no populated <td>s — observed on the 2026-09-08 and -09 runs as
    // rowCount 9 with rows 4-8 unreadable, against the 4 real rows the
    // finished table settles to (confirmed live 2026-09-09). The old code
    // burned 25s per run on that and emitted five alarming log lines for
    // what is a normal intermediate state; readUntilStable is what actually
    // waits for the table to finish.
    const cellCount = await rowLocator.nth(i).locator('td').count();
    if (cellCount <= branchNameCellIndexInRow) {
      rowBranchNames.push('');
      continue;
    }
    try {
      name = (await rowLocator.nth(i).locator('td').nth(branchNameCellIndexInRow).innerText({ timeout: 2000 })).trim();
    } catch (err) {
      log(`Scraper: could not read branch-name cell for row ${i}: ${err.message}`);
    }
    rowBranchNames.push(name);
  }

  for (const { dashboardName, sheetTab } of config.branches) {
    const matchingIndices = rowBranchNames.reduce((acc, name, i) => (name === dashboardName ? [...acc, i] : acc), []);
    if (matchingIndices.length > 1) {
      log(`Scraper: expected exactly one row for ${dashboardName}, found ${matchingIndices.length}; using the first match.`);
    }
    if (matchingIndices.length === 0) {
      log(`Scraper: no row with exact branch name "${dashboardName}" found; GM value will be missing.`);
      values[sheetTab] = null;
      continue;
    }
    const row = rowLocator.nth(matchingIndices[0]);
    const gmCell = row.locator('td').nth(gmCellIndexInRow);
    let text = null;
    try {
      text = await gmCell.locator('span').first().innerText({ timeout: 5000 });
    } catch (err) {
      log(`Scraper: could not read GM cell for ${dashboardName}: ${err.message}`);
    }
    const value = parsePercent(text);
    if (value === null) {
      log(`Scraper: GM value missing/unparseable for ${dashboardName} (raw="${text}")`);
    }
    values[sheetTab] = value;
  }

  return values;
}

// Reads the company-wide "GROSS MARGIN" KPI card at the top of the page
// (distinct from the per-branch GM column in the table below) — its label
// changes with the selected range (e.g. "TODAY GROSS MARGIN",
// "12 AUGUST 2026 GROSS MARGIN", "1 AUG - 12 AUG 2026 GROSS MARGIN") but
// always ends in "GROSS MARGIN" and, unlike the GM Projection card, never
// contains "PROJECTION".
async function scrapeOverallGm(page) {
  const labels = page.locator('div', { hasText: /GROSS MARGIN/i });
  const count = await labels.count();
  for (let i = 0; i < count; i++) {
    const label = labels.nth(i);
    const text = (await label.innerText().catch(() => '')).trim();
    if (!text || text.includes('\n') || /PROJECTION/i.test(text) || !/GROSS MARGIN$/i.test(text)) continue;
    if (!(await label.isVisible().catch(() => false))) continue;
    const value = await label.evaluate((node) => node.nextElementSibling?.textContent?.trim() || null);
    if (value) return value;
  }
  return null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3));

function formatRangeLabel(date) {
  return `${String(date.getDate()).padStart(2, '0')} ${MONTH_ABBR[date.getMonth()]}`;
}

async function navigateCalendarToMonth(page, year, month) {
  const { calendarMonthCaption, calendarPrevMonthButton, calendarNextMonthButton } = config.eaf.selectors;
  // Safety cap — a couple of years' worth of months is more than this
  // pipeline will ever need to travel in one call.
  for (let i = 0; i < 24; i++) {
    const caption = await page.locator(calendarMonthCaption).first().innerText();
    const m = caption.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!m) throw new Error(`Unexpected calendar caption: "${caption}"`);
    const curMonth = MONTH_NAMES.indexOf(m[1]);
    const curYear = parseInt(m[2], 10);
    if (curYear === year && curMonth === month) return;

    const forward = (year - curYear) * 12 + (month - curMonth) > 0;
    await page.locator(forward ? calendarNextMonthButton : calendarPrevMonthButton).first().click();
    await page.waitForTimeout(200);
  }
  throw new Error(`Could not navigate calendar to ${MONTH_NAMES[month]} ${year}`);
}

async function clickCalendarDay(page, date) {
  await navigateCalendarToMonth(page, date.getFullYear(), date.getMonth());
  const day = date.getDate();
  await page
    .locator(config.eaf.selectors.calendarDayButton, { hasText: new RegExp(`^${day}$`) })
    .first()
    .click();
  await page.waitForTimeout(300);
}

// The Apply Filter button stays disabled for a beat after the second day
// click while the picker's internal state catches up — observed in
// production taking long enough to exhaust every click-timeout retry
// (run.log, 2026-08-13 08:47-08:49). Poll its disabled state explicitly
// instead of guessing a fixed sleep is long enough.
async function waitForApplyFilterEnabled(page) {
  const button = page.locator(config.eaf.selectors.applyFilterButton).first();
  for (let i = 0; i < 20; i++) {
    if (await button.isVisible().catch(() => false)) {
      if (!(await button.isDisabled().catch(() => true))) return button;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Apply Filter button never became enabled after selecting the date range.');
}

// Picks an explicit start/end date on the "Custom Range" calendar and
// applies it — used for both the daily and MTD reads so the scraper never
// depends on the dashboard's "Today"/"This Month" presets, which mean
// different calendar days depending on when the script happens to run.
// The range label the dashboard renders for an applied custom range. Shared
// by selectCustomRange (which waits for it after applying) and readGmSnapshot
// (which re-asserts it is still on screen at the moment values are read), so
// the two can never drift apart.
function rangeLabelFor(startDate, endDate) {
  return `${formatRangeLabel(startDate)} - ${formatRangeLabel(endDate)} ${endDate.getFullYear()}`;
}

async function selectCustomRange(page, startDate, endDate) {
  await page.locator(config.eaf.selectors.dateRangeSelect).first().selectOption(config.eaf.selectors.customRangeOptionValue);
  await page.waitForTimeout(800);
  await clickCalendarDay(page, startDate);
  await clickCalendarDay(page, endDate);
  const applyButton = await waitForApplyFilterEnabled(page);
  await applyButton.click();
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  // Confirm the page actually re-rendered for the requested range before
  // trusting anything read off it — an Apply Filter click can succeed while
  // the table content briefly (or, during a flaky load, not-so-briefly)
  // still reflects the previous selection. Poll rather than trust one fixed
  // wait.
  const expectedLabel = rangeLabelFor(startDate, endDate);
  let confirmed = false;
  for (let i = 0; i < 8 && !confirmed; i++) {
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (bodyText.includes('Failed to fetch')) {
      throw new Error('Dashboard showed "Failed to fetch" after applying date range.');
    }
    if (bodyText.includes(expectedLabel)) {
      confirmed = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!confirmed) {
    throw new Error(`Dashboard never showed expected range "${expectedLabel}" after applying.`);
  }
}

// Reads both the per-branch table GM and the overall KPI card together, so
// a "stable" snapshot means both agree across two consecutive reads — not
// just one of the two.
async function readGmSnapshot(page, expectedRangeLabel = null) {
  const perBranch = await scrapeGmForCurrentView(page);
  const overallRaw = await scrapeOverallGm(page);
  // Re-assert the applied range is *still* the one on screen at the moment
  // these values were read. selectCustomRange confirms the label once, right
  // after clicking Apply Filter, and then trusts it — but the table can
  // revert to the dashboard's default "today" view after that check passes.
  // Observed 2026-09-09: a backfill read of the 01 Aug - 31 Aug range came
  // back with the default view's figures (Bunju 29.1%, Dodoma 18.6%,
  // Kinyerezi 25.6%, Onja 0.0%) and nothing caught it; an immediate re-run of
  // the identical call returned the correct August MTD (23.1/22.8/16.2/28.5)
  // and matched the 05:00 figures in cron.log exactly. Silently reading the
  // wrong period is the same class of bug as reading the placeholder, and
  // just as invisible downstream, so it is rejected the same way.
  let rangeLabelPresent = true;
  if (expectedRangeLabel) {
    const bodyText = await page.evaluate(() => document.body.innerText);
    rangeLabelPresent = bodyText.includes(expectedRangeLabel);
  }
  return { perBranch, overallRaw, rangeLabelPresent };
}

// True when two snapshots carry the same figures (ignoring the range-label
// bookkeeping field).
function sameFigures(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a.perBranch) === JSON.stringify(b.perBranch) && a.overallRaw === b.overallRaw;
}

// A snapshot is only usable if it is populated, was read off the range it was
// supposed to be read off, and is not simply the pre-filter view that was on
// screen before Apply Filter was clicked.
//
// That last one is the actual root cause behind both of the bad writes this
// pipeline has made. Every scrape starts from loadDashboardFresh(), which
// leaves the dashboard on its default "today" range; the custom range is
// applied on top. The range *label* re-renders the moment Apply Filter is
// clicked, but the table keeps showing the default view's numbers for a
// while after that — so neither selectCustomRange's label wait nor
// readGmSnapshot's label re-assert proves the figures belong to the
// requested period, and readUntilStable is happy because a stale table is
// perfectly stable.
//
// Caught red-handed 2026-09-09: two back-to-back scrapes of 2026-08-31
// returned identical (correct) daily figures and different MTD figures —
// one the default view's (Bunju 29.1%, Dodoma 18.6%, Kinyerezi 25.6%, Onja
// 0.0%), one the real August MTD (23.1/22.8/16.2/28.5, matching cron.log's
// 05:00 line exactly). It is also the most likely explanation for the 0.0%
// MTD written on 2026-09-01 and 2026-09-06: those runs read at ~05:30, when
// the default "today" view is a few hours into a day with no data in it yet
// — an all-zero table that is not a placeholder at all, but a real reading
// of the wrong day.
function rejectSnapshot(snapshot, baseline = null) {
  return (
    isUnpopulatedSnapshot(snapshot) ||
    snapshot.rangeLabelPresent === false ||
    sameFigures(snapshot, baseline)
  );
}

// selectCustomRange only confirms the date-range *label* has re-rendered —
// the range label and the GM KPI card are populated by separate async calls
// on this SPA, and the label can settle before the card's number catches up
// (observed 2026-08-13: MTD read 27.5% once vs. 24.7% on 3 other identical
// reads, with no error/retry logged — a silent stale-value race, not a
// caught failure). Re-reading until two consecutive reads agree confirms the
// number has actually finished updating for the applied range, not just the
// label. If it never settles, throw so the outer retry reloads with a fresh
// browser instead of trusting a possibly-stale figure.
//
// `rejectIf` marks a reading as "not a reading at all" — see
// isUnpopulatedSnapshot. Stability alone can't catch that case: the
// placeholder is perfectly stable, which is exactly how it got written to
// the sheet twice. A rejected read also resets `previous`, so two
// consecutive placeholders can never agree their way through.
//
// Polls to a deadline rather than a fixed 4 reads (~3s). The MTD view
// queries a whole month and is routinely slower to populate than the
// single-day view — 3s was not enough headroom for it, which is why the
// placeholder kept being read as final.
async function readUntilStable(
  page,
  readFn,
  { intervalMs = 1000, settleTimeoutMs = 30000, rejectIf = null, rejectDescription = 'unpopulated' } = {}
) {
  const deadline = Date.now() + settleTimeoutMs;
  let previous = null;
  let sawRejected = false;
  while (Date.now() < deadline) {
    const current = await readFn();
    if (rejectIf && rejectIf(current)) {
      sawRejected = true;
      previous = null;
      await page.waitForTimeout(intervalMs);
      continue;
    }
    if (previous !== null && JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(
    `GM reading never stabilized within ${settleTimeoutMs}ms — dashboard ${sawRejected ? `stayed ${rejectDescription}` : 'likely still updating'}.`
  );
}

// True when a snapshot is the dashboard's "range applied, numbers not back
// yet" state rather than a real reading.
//
// That state renders every GM figure as 0.0%, and it is *stable*, so
// readUntilStable used to hand it back as a good reading. On 2026-09-01 and
// 2026-09-06 the 05:30 verify run read exactly this and wrote zeros over the
// correct MTD GM the 05:00 run had already put in the sheet — BUNJU 23.1% →
// 0.0%, OVERALL 21.0% → 0.0%, and so on. collectCellUpdate (manualEntryRows)
// already refuses to write a null, but 0 is a number and sailed straight
// through it.
//
// Deliberately requires *every* figure to be zero/absent at once. A single
// branch really can be 0.0% — confirmed live on 2026-09-09, where "Onja
// Channel" was 0.0% while the other three were 19.7%/14.1%/8.2% — so
// rejecting any zero would throw away real data. All four branches AND the
// overall KPI card reading exactly zero simultaneously is the placeholder,
// never a real month.
function isUnpopulatedSnapshot({ perBranch, overallRaw }) {
  const values = config.branches.map(({ sheetTab }) => perBranch[sheetTab]);
  values.push(parsePercent(overallRaw));
  return values.every((v) => v === null || v === 0);
}

async function scrapeGmOnce(targetDate, runLabel) {
  if (!fs.existsSync(config.eaf.sessionStatePath)) {
    throw new Error(
      `No persisted EAF session found at ${config.eaf.sessionStatePath}. Run scripts/captureEafSession.js first.`
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: config.eaf.sessionStatePath,
    });
    const page = await context.newPage();

    // Reloads the dashboard from scratch. The custom-range picker is only
    // reliable when it starts from this fresh state — reusing one page load
    // across two range selections leaves stale from/to state that either
    // disables Apply Filter or silently re-applies the first range (both
    // observed while building this).
    async function loadDashboardFresh() {
      await page.goto(config.eaf.url, { waitUntil: 'load', timeout: 30000 });

      // Race the login form against the dashboard rather than testing the
      // URL the instant goto() resolved — this SPA can swap in the login
      // form without a URL change, and at `load` neither has rendered yet.
      // See dashboardReady.js for what that cost on the LCC side.
      // Doubles as the "stuck on Loading dashboard..." guard the URL check
      // used to be paired with: if neither appears, this throws and the
      // outer retry reloads with a fresh browser.
      const outcome = await waitForDashboardOrLogin(page, {
        dashboardSelector: config.eaf.selectors.dateRangeSelect,
        loginSelector: config.eaf.selectors.loginPasswordInput,
      });
      if (outcome === 'login') {
        throw new SessionExpiredError('EAF session expired — redirected to login page.');
      }

      const branchesTab = page.locator(config.eaf.selectors.branchesPerformanceTab).first();
      if (await branchesTab.count()) {
        await branchesTab.click().catch(() => {});
      }

      // The default-range view the table shows before any custom range is
      // applied, handed back so the reads below can reject it if the table is
      // still showing it once a range has been applied.
      //
      // This has to wait for the table to actually populate. Reading it
      // straight after the tab click returns an empty table (the branch rows
      // haven't rendered), which matches nothing and silently disables the
      // guard — measured doing exactly that on 2026-09-09, four "no row with
      // exact branch name" lines per load and a baseline of nulls. If it
      // still won't populate in time, hand back null: the guard is then off,
      // but isUnpopulatedSnapshot and the range-label check still apply.
      return readUntilStable(page, () => readGmSnapshot(page), {
        settleTimeoutMs: 15000,
        rejectIf: isUnpopulatedSnapshot,
      }).catch(() => null);
    }

    const firstOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);

    const dailyBaseline = await loadDashboardFresh();
    await selectCustomRange(page, targetDate, targetDate);
    const dailyLabel = rangeLabelFor(targetDate, targetDate);
    const dailySnapshot = await readUntilStable(page, () => readGmSnapshot(page, dailyLabel), {
      rejectIf: (s) => rejectSnapshot(s, dailyBaseline),
      rejectDescription: 'unpopulated, on a different date range, or still showing the pre-filter view',
    });
    const daily = dailySnapshot.perBranch;
    const overallDailyRaw = dailySnapshot.overallRaw;

    // Evidence shot of the primary "Branches Performance" (daily) view —
    // the one this pipeline's figures actually come from — once the reading
    // has stabilized, so it reflects the numbers that ended up in the sheets.
    if (runLabel) await captureEvidence(page, targetDate, runLabel);

    const mtdBaseline = await loadDashboardFresh();
    await selectCustomRange(page, firstOfMonth, targetDate);
    const mtdLabel = rangeLabelFor(firstOfMonth, targetDate);
    const mtdSnapshot = await readUntilStable(page, () => readGmSnapshot(page, mtdLabel), {
      rejectIf: (s) => rejectSnapshot(s, mtdBaseline),
      rejectDescription: 'unpopulated, on a different date range, or still showing the pre-filter view',
    });
    const mtd = mtdSnapshot.perBranch;
    const overallMtdRaw = mtdSnapshot.overallRaw;

    const result = {};
    for (const { sheetTab } of config.branches) {
      result[sheetTab] = { daily: daily[sheetTab], mtd: mtd[sheetTab] };
    }
    result.OVERALL = { daily: parsePercent(overallDailyRaw), mtd: parsePercent(overallMtdRaw) };
    if (result.OVERALL.daily === null) log(`Scraper: overall GM (daily) missing/unparseable (raw="${overallDailyRaw}")`);
    if (result.OVERALL.mtd === null) log(`Scraper: overall GM (mtd) missing/unparseable (raw="${overallMtdRaw}")`);
    return result;
  } finally {
    await browser.close();
  }
}

// Scrapes GM (daily + month-to-date) for all 4 branches for targetDate,
// returned keyed by sheet tab name, e.g. { BUNJU: { daily, mtd }, ... }.
// Both figures come from explicit calendar-day selection (targetDate for
// daily, 1st-of-month through targetDate for MTD) rather than the
// dashboard's "Today"/"This Month" presets, so the result is deterministic
// regardless of what time the script actually runs. Retries transient
// failures (slow dashboard load, network blips) with a fresh browser each
// time; a genuinely expired session is never retried since that needs a
// human to re-run scripts/captureEafSession.js, not another attempt.
async function scrapeGm(targetDate, runLabel) {
  const { attempts, delayMs } = config.eaf.retry;
  let lastErr;
  let relinked = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await scrapeGmOnce(targetDate, runLabel);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // Re-link once, in-run, rather than failing every run until a human
        // notices the alert and runs scripts/captureEafSession.js by hand —
        // that manual-only loop is what cost two days of EAL reporting when
        // the LCC session expired on 2026-09-08. Login is unattended-safe on
        // both sites (see sessionCapture.js). Guarded to a single attempt so
        // a genuinely wrong/locked credential fails the run instead of
        // hammering the login form.
        if (relinked) throw err;
        relinked = true;
        log('Scraper: EAF session expired — re-capturing it and retrying.');
        try {
          await captureSession('eaf');
        } catch (captureErr) {
          log(`Scraper: EAF session re-capture failed: ${captureErr.message}`);
          throw err;
        }
        attempt--; // the re-link shouldn't cost one of the transient-failure retries
        continue;
      }
      lastErr = err;
      const willRetry = attempt < attempts;
      log(
        `Scraper: attempt ${attempt}/${attempts} failed (${err.message})${willRetry ? ', retrying...' : ', giving up.'}`
      );
      if (willRetry) await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}

module.exports = { scrapeGm, SessionExpiredError, parsePercent, isUnpopulatedSnapshot, rejectSnapshot, sameFigures, readUntilStable, rangeLabelFor };
