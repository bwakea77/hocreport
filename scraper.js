const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config');
const { log } = require('./logger');
const { captureEvidence } = require('./evidence');

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
    try {
      name = (await rowLocator.nth(i).locator('td').nth(branchNameCellIndexInRow).innerText({ timeout: 5000 })).trim();
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
  const expectedLabel = `${formatRangeLabel(startDate)} - ${formatRangeLabel(endDate)} ${endDate.getFullYear()}`;
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
async function readGmSnapshot(page) {
  const perBranch = await scrapeGmForCurrentView(page);
  const overallRaw = await scrapeOverallGm(page);
  return { perBranch, overallRaw };
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
async function readUntilStable(page, readFn, { maxAttempts = 4, intervalMs = 1000 } = {}) {
  let previous = await readFn();
  for (let i = 1; i < maxAttempts; i++) {
    await page.waitForTimeout(intervalMs);
    const current = await readFn();
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  throw new Error('GM reading never stabilized across repeated reads — dashboard likely still updating.');
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

      if (/\/login/.test(page.url())) {
        throw new SessionExpiredError('EAF session expired — redirected to login page.');
      }

      // The dashboard sometimes sits on a "Loading dashboard..." screen for
      // a while — fail fast here so the outer retry can reload with a
      // fresh browser instead of burning the whole attempt on one timeout.
      await page.locator(config.eaf.selectors.dateRangeSelect).first().waitFor({ state: 'attached', timeout: 15000 });

      const branchesTab = page.locator(config.eaf.selectors.branchesPerformanceTab).first();
      if (await branchesTab.count()) {
        await branchesTab.click().catch(() => {});
      }
    }

    const firstOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);

    await loadDashboardFresh();
    await selectCustomRange(page, targetDate, targetDate);
    const dailySnapshot = await readUntilStable(page, () => readGmSnapshot(page));
    const daily = dailySnapshot.perBranch;
    const overallDailyRaw = dailySnapshot.overallRaw;

    // Evidence shot of the primary "Branches Performance" (daily) view —
    // the one this pipeline's figures actually come from — once the reading
    // has stabilized, so it reflects the numbers that ended up in the sheets.
    if (runLabel) await captureEvidence(page, targetDate, runLabel);

    await loadDashboardFresh();
    await selectCustomRange(page, firstOfMonth, targetDate);
    const mtdSnapshot = await readUntilStable(page, () => readGmSnapshot(page));
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
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await scrapeGmOnce(targetDate, runLabel);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
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

module.exports = { scrapeGm, SessionExpiredError, parsePercent };
