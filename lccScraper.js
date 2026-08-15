const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config');
const { log } = require('./logger');
const { captureEvidence } = require('./evidence');
const { SessionExpiredError } = require('./scraper');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(text) {
  if (text === undefined || text === null) return null;
  const cleaned = String(text).replace(/,/g, '').trim();
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatShortDate(date) {
  return `${MONTH_ABBR[date.getMonth()]} ${date.getDate()}`;
}

// Channel names exactly as they render as the clickable row label — maps to
// the "channel" keys used elsewhere in this file (externalTransport/transit/
// other). Declared before readKpiAndChannel (which iterates it) rather than
// after, since it's used there now.
const CHANNELS = [
  { label: 'External Transport', key: 'externalTransport' },
  { label: 'Transit', key: 'transit' },
  { label: 'Other', key: 'other' },
];

// Escapes regex metacharacters in a literal string used inside a
// dynamically-built RegExp — none of CHANNELS' labels currently contain any,
// but this is cheap insurance against a future label like "Other (Misc.)".
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One independent regex per channel row, rather than a single regex spanning
// all three — a single combined regex means a layout/wording change affecting
// just ONE channel (renamed, reordered, an extra badge inserted) fails the
// whole match and nulls out all three channels' values, even though the
// other two rows are still perfectly readable on the same page. Matching each
// channel independently means a change to one row only ever costs that row.
function matchChannelValue(bodyText, label) {
  const re = new RegExp(`${escapeRegExp(label)}\\n[↑↓][\\d.]+%\\n[\\d.]+%\\n([\\d,]+)`);
  const m = bodyText.match(re);
  return m ? parseNumber(m[1]) : null;
}

// Only the "actual" figure off each KPI card and each channel's revenue
// value — LCC_SNAPSHOT only ever shows a flat Channel/Value/Blended GM/EBITDA
// table, so achievement %, target, delta, and share (all present on the page
// but not in that table) are never parsed here.
function readKpiAndChannel(bodyText) {
  const revenueMatch = bodyText.match(/REVENUE\n[\d.]+%\n[▲▼]\nA:\nTZS ([\d,]+)\n/);
  const revenue = { actual: revenueMatch ? parseNumber(revenueMatch[1]) : null };
  if (!revenueMatch) log('LCC scraper: could not parse REVENUE KPI card.');

  const gmMatch = bodyText.match(/GROSS MARGIN\n[\d.-]+%\n[▲▼]\nA:\n([\d.-]+)%\n/);
  const grossMargin = { actual: gmMatch ? `${gmMatch[1]}%` : null };
  if (!gmMatch) log('LCC scraper: could not parse GROSS MARGIN KPI card.');

  const ebitdaMatch = bodyText.match(/EBITDA\n[\d.-]+%\n[▲▼]\nA:\n([\d.-]+)%\n/);
  const ebitda = { actual: ebitdaMatch ? `${ebitdaMatch[1]}%` : null };
  if (!ebitdaMatch) log('LCC scraper: could not parse EBITDA KPI card.');

  const channel = {};
  for (const { label, key } of CHANNELS) {
    const value = matchChannelValue(bodyText, label);
    channel[key] = { value };
    if (value === null) log(`LCC scraper: could not parse Revenue by Channel row for "${label}".`);
  }

  return { revenue, grossMargin, ebitda, channel };
}

// Clicking a channel row drills into a truck-level breakdown for that
// channel, headed by a "Blended GM: X%" figure — the one piece of
// channel-level GM this dashboard exposes (the top-level Revenue by Channel
// card only has value/share/delta, no GM). Browser back-navigation
// (page.goBack()) does NOT reliably restore this SPA's filter/period state
// after a drill-in (confirmed 2026-08-14 — the PERIOD bar and channel rows
// were simply gone afterward), so each channel gets its own fresh page load
// + filter reselect + click, same as EAF's "reload dashboard fresh between
// reads" pattern in scraper.js and for the same reason. `filter` is either a
// periodFilter or customRangeFilter (see below) — whichever was used for the
// main view's read, so the drilldown reflects the same date(s).
async function readBlendedGm(browser, filter, channelLabel) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    storageState: config.lcc.sessionStatePath,
  });
  try {
    const page = await context.newPage();
    await page.goto(config.lcc.url, { waitUntil: 'load', timeout: 30000 });
    await page.locator(config.lcc.selectors.filtersButton).first().waitFor({ state: 'attached', timeout: 15000 });
    await filter.apply(page);

    await page.locator('text=' + channelLabel).first().click();

    let previous = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const text = await page.evaluate(() => document.body.innerText);
      const m = text.match(/Blended GM: ([\d.-]+)%/);
      if (!m) {
        previous = null;
        continue;
      }
      if (previous === m[1]) return `${m[1]}%`;
      previous = m[1];
    }
    throw new Error(`Blended GM for "${channelLabel}" never stabilized.`);
  } finally {
    await context.close();
  }
}

// "MTD"'s range end is always "today" — whatever day the scrape actually
// runs — independent of targetDate (which for the morning runs is
// yesterday), so it's confirmed generically (any "MTD\n<Mon D> – <Mon D>"
// badge) rather than computing an exact expected end date here.
const MTD_RANGE_PATTERN = /MTD\n[A-Za-z]{3} \d{1,2} – [A-Za-z]{3} \d{1,2}/;

function isPeriodConfirmed(text, period, targetDate) {
  if (text.includes('Refreshing data')) return false;
  if (period === 'MTD') return MTD_RANGE_PATTERN.test(text);
  const expectedRangeLabel = `${formatShortDate(targetDate)} – ${formatShortDate(targetDate)}`;
  return text.includes(`${period}\n${expectedRangeLabel}`);
}

// Selects the given PERIOD filter (button label exactly as shown: "Today",
// "Yesterday", or "MTD") and waits for the page to actually finish
// re-rendering for it. Unlike EAF's single "Failed to fetch"/label-based
// check, this dashboard's sections load independently and asynchronously —
// the KPI cards and channel breakdown settle at different times (confirmed
// 2026-08-14: a naive 2.5s wait caught the channel section still showing the
// *previous* period's numbers after the KPI cards had already updated). So
// this polls the whole page's text until two consecutive reads agree AND the
// expected period+date-range badge (e.g. "Yesterday\nAug 13 – Aug 13") is
// present, confirming every section has caught up to the selected period.
async function selectPeriodAndWaitForSettle(page, period, targetDate) {
  await page.locator(config.lcc.selectors.filtersButton).first().click();
  await page.waitForTimeout(500);
  await page.locator(config.lcc.selectors.periodButton(period)).first().click();

  let previous = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body.innerText);
    if (!isPeriodConfirmed(text, period, targetDate)) {
      previous = null;
      continue;
    }
    if (previous === text) return;
    previous = text;
  }
  throw new Error(`LCC dashboard never stabilized on period "${period}".`);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
function isoDateCompact(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Finds the visible "Custom Date" calendar's month panel captioned e.g.
// "August 2026" — confirmed 2026-08-14: the picker shows exactly two months
// (the current one and the next) with day cells as plain
// non-attributed <div class="cursor-pointer">N</div> (not <button>, unlike
// EAF's calendar). No prev/next month navigation has been verified yet, so
// this only supports dates within those two visible months and throws
// rather than guessing at unverified controls for anything further out —
// used for one-off/backfill custom-range reads, not the daily automation.
async function lccCalendarMonthPanel(page, date) {
  const label = `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
  const panel = page
    .locator('p', { hasText: new RegExp(`^${label}$`) })
    .locator('xpath=ancestor::div[contains(@class,"min-w-")]')
    .first();
  if (!(await panel.count())) {
    throw new Error(
      `LCC custom-date calendar doesn't show "${label}" in either visible month panel (only the current and next month are shown; further navigation isn't implemented).`
    );
  }
  return panel;
}

async function clickLccCalendarDay(page, date) {
  const panel = await lccCalendarMonthPanel(page, date);
  await panel.locator('div.cursor-pointer', { hasText: new RegExp(`^${date.getDate()}$`) }).first().click();
  await page.waitForTimeout(300);
}

// Selects an explicit start/end date on the "Custom Date" range picker (same
// two-click "set start, set end" interaction as EAF's calendar; clicking the
// same day twice selects a single day) and waits for every section of the
// page to catch up — confirmed 2026-08-14: the header's range badge
// ("Transport P&L · 2026-08-03 – 2026-08-03") updates before the
// REVENUE/GROSS MARGIN/channel sections actually populate with real figures,
// so this polls for the badge AND a populated REVENUE section AND two
// consecutive identical reads, same reasoning as
// selectPeriodAndWaitForSettle below.
async function selectCustomDateRange(page, startDate, endDate) {
  await page.locator(config.lcc.selectors.filtersButton).first().click();
  await page.waitForTimeout(500);
  await page.locator('button:has-text("Custom Date")').first().click();
  await page.waitForTimeout(800);
  await clickLccCalendarDay(page, startDate);
  await clickLccCalendarDay(page, endDate);
  await page.locator('button:has-text("Apply")').first().click();

  const expectedBadge = `${isoDateCompact(startDate)} – ${isoDateCompact(endDate)}`;
  let previous = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body.innerText);
    if (!text.includes(expectedBadge) || !/\nREVENUE\n/.test(text) || text.includes('Refreshing data')) {
      previous = null;
      continue;
    }
    if (previous === text) return;
    previous = text;
  }
  throw new Error(`LCC dashboard never stabilized on Custom Date range "${expectedBadge}".`);
}

// Two ways to filter the dashboard, used interchangeably by
// scrapeLccOnceWithFilter/readBlendedGm: a relative PERIOD button
// (Yesterday/Today/MTD, used by the daily automation) or an explicit
// start/end date range (used for one-off backfills of a specific past day).
function periodFilter(period, targetDate) {
  return { describe: () => period, apply: (page) => selectPeriodAndWaitForSettle(page, period, targetDate) };
}
function customRangeFilter(startDate, endDate) {
  return {
    describe: () => `${isoDateCompact(startDate)} to ${isoDateCompact(endDate)}`,
    apply: (page) => selectCustomDateRange(page, startDate, endDate),
  };
}

async function scrapeLccOnceWithFilter(filter, runLabel, evidenceDate) {
  if (!fs.existsSync(config.lcc.sessionStatePath)) {
    throw new Error(`No persisted LCC session found at ${config.lcc.sessionStatePath}. Run scripts/captureLccSession.js first.`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      storageState: config.lcc.sessionStatePath,
    });
    const page = await context.newPage();

    await page.goto(config.lcc.url, { waitUntil: 'load', timeout: 30000 });

    const stillOnLogin = await page.locator(config.lcc.selectors.loginPasswordInput).count();
    if (stillOnLogin > 0) {
      throw new SessionExpiredError('LCC session expired — redirected to login page.');
    }

    await page.locator(config.lcc.selectors.filtersButton).first().waitFor({ state: 'attached', timeout: 15000 });
    await filter.apply(page);

    if (runLabel) await captureEvidence(page, evidenceDate, runLabel);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const { revenue, grossMargin, ebitda, channel } = readKpiAndChannel(bodyText);

    // Blended GM% per channel needs its own fresh page load per channel (see
    // readBlendedGm) — done after everything else on the main view so a
    // failure here doesn't cost the reads that already succeeded.
    for (const { label, key } of CHANNELS) {
      channel[key].blendedGm = await readBlendedGm(browser, filter, label);
    }

    return { revenue, grossMargin, ebitda, channel };
  } finally {
    await browser.close();
  }
}

async function scrapeLccWithRetry(filter, evidenceDate, runLabel) {
  const { attempts, delayMs } = config.lcc.retry;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await scrapeLccOnceWithFilter(filter, runLabel, evidenceDate);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      lastErr = err;
      const willRetry = attempt < attempts;
      log(`LCC scraper: attempt ${attempt}/${attempts} failed (${err.message})${willRetry ? ', retrying...' : ', giving up.'}`);
      if (willRetry) await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}

// Scrapes the EAL Dashboard (Transport P&L) for the given PERIOD ("Yesterday"
// for the 05:00/05:30 morning runs, "Today" for the 16:25 EOD run, "MTD" for
// the Yesterday block's second channel table). Retries transient failures
// with a fresh browser, same as scrapeGm; a genuinely expired session is
// never retried since that needs scripts/captureLccSession.js, not another
// attempt.
async function scrapeLcc(period, targetDate, runLabel) {
  return scrapeLccWithRetry(periodFilter(period, targetDate), targetDate, runLabel);
}

// Scrapes the EAL Dashboard for an explicit start/end date range via the
// "Custom Date" filter — used for backfilling a specific past day (or range)
// that isn't reachable via the Yesterday/Today/MTD relative buttons. Pass
// the same date for start and end to read a single day.
async function scrapeLccCustomRange(startDate, endDate, runLabel) {
  return scrapeLccWithRetry(customRangeFilter(startDate, endDate), endDate, runLabel);
}

// Lists which fields of a scraped LCC channel table (see readKpiAndChannel)
// came back null/unparseable — readKpiAndChannel itself only logs these and
// returns nulls rather than throwing (a page structure change shouldn't
// abort the whole scrape when most of the page still parsed fine), so
// nothing upstream otherwise notices a partial read. The caller uses this to
// alert on gaps the same way the EAF pipeline's alertOnGaps does, instead of
// a "success" log line masking missing data (confirmed happening silently
// in run.log, 2026-08-14 11:20 — "could not parse Revenue by Channel
// section" with no alert).
function findLccGaps(data) {
  const gaps = [];
  if (data.revenue.actual === null) gaps.push('revenue');
  if (data.grossMargin.actual === null) gaps.push('gross margin');
  if (data.ebitda.actual === null) gaps.push('ebitda');
  for (const { label, key } of CHANNELS) {
    if (data.channel[key].value === null) gaps.push(`${label} value`);
  }
  return gaps;
}

module.exports = { scrapeLcc, scrapeLccCustomRange, findLccGaps, readKpiAndChannel };
