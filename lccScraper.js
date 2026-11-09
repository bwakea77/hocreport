const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config');
const { log } = require('./logger');
const { captureEvidence } = require('./evidence');
const { SessionExpiredError } = require('./scraper');
const { waitForDashboardOrLogin } = require('./dashboardReady');
const { captureSession } = require('./sessionCapture');

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
//
// Site redesign (first seen in run.log 2026-08-28): a channel row used to
// render as Label / delta% / achievement% / revenue; it now renders as
// Label / revenue / delta% / optional "GM X%" line — revenue is the first
// number right after the label, not the last, and the trailing GM line isn't
// always present (confirmed live 2026-08-31: "Other" never shows one), so
// this only captures the revenue number and doesn't require anything after
// it.
function matchChannelValue(bodyText, label) {
  const re = new RegExp(`${escapeRegExp(label)}\\n([\\d,]+)\\n`);
  const m = bodyText.match(re);
  return m ? parseNumber(m[1]) : null;
}

// Only the "actual" figure off each KPI card and each channel's revenue
// value — LCC_SNAPSHOT only ever shows a flat Channel/Value/Blended GM/EBITDA
// table, so achievement %, target, delta, and share (all present on the page
// but not in that table) are never parsed here.
//
// Site redesign (first seen in cron.log 2026-10-31 16:25): the KPI cards
// went from "REVENUE / 191.1% / ▲ / A: / TZS 83,433,000 / T: ..." to
// "REVENUE / 17.7% / ▼ / Actual / TZS 8.0M / Target / TZS 45.1M" — the
// "A:" label became "Actual", and the revenue card now shows a rounded
// abbreviation (8.0M) instead of the exact figure. The exact revenue is
// still on the page as the Revenue by Channel header total
// ("Revenue breakdown by stream / TZS 7,990,000"), confirmed live
// 2026-11-09 to equal the sum of the channel rows, so revenue is read from
// there. Both card layouts are accepted, and the trend arrow is optional.
function kpiPercentRe(title) {
  return new RegExp(`${title}\\n[\\d.-]+%\\n(?:[▲▼]\\n)?(?:A:|Actual)\\n([\\d.-]+)%\\n`);
}

function readKpiAndChannel(bodyText) {
  const channelTotalMatch = bodyText.match(/Revenue breakdown by stream\n+TZS ([\d,]+)\n/);
  const oldCardMatch = bodyText.match(/REVENUE\n[\d.-]+%\n(?:[▲▼]\n)?A:\nTZS ([\d,]+)\n/);
  const revenueMatch = channelTotalMatch || oldCardMatch;
  const revenue = { actual: revenueMatch ? parseNumber(revenueMatch[1]) : null };
  if (!revenueMatch) log('LCC scraper: could not parse REVENUE KPI card.');

  const gmMatch = bodyText.match(kpiPercentRe('GROSS MARGIN'));
  const grossMargin = { actual: gmMatch ? `${gmMatch[1]}%` : null };
  if (!gmMatch) log('LCC scraper: could not parse GROSS MARGIN KPI card.');

  const ebitdaMatch = bodyText.match(kpiPercentRe('EBITDA'));
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
// channel, headed by a "GM%: X%" figure (was "Blended GM: X%" before the
// 2026-08-28 site redesign) — the one piece of channel-level GM this
// dashboard reliably exposes for every channel; the top-level Revenue by
// Channel card only shows it inline for some channels (confirmed live
// 2026-08-31: never for "Other"), so the drilldown stays the single source
// used for all three. Browser back-navigation
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
    // Same login/dashboard race as the main view — a session that expires
    // mid-scrape (or between the main read and these three drilldowns) would
    // otherwise surface here as a Filters-button timeout too.
    if (
      (await waitForDashboardOrLogin(page, {
        dashboardSelector: config.lcc.selectors.filtersButton,
        loginSelector: config.lcc.selectors.loginPasswordInput,
      })) === 'login'
    ) {
      throw new SessionExpiredError('LCC session expired — redirected to login page.');
    }
    await filter.apply(page);

    await page.locator('text=' + channelLabel).first().click();

    let previous = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const text = await page.evaluate(() => document.body.innerText);
      const m = text.match(/GM%: ([\d.-]+)%/);
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

// Truck plate rows in a channel's "Trucks" drilldown render (innerText) as
// e.g. "T 560 EHU\t16,430,000\t\n25.0%\n\t71.1%\t1" — TRUCK / REVENUE /
// REVENUE SHARE / GM% / TRIPS, with REVENUE SHARE wrapping onto its own
// line. Only the plate + the revenue figure immediately after it (before
// that wrap) are needed here.
const TRUCK_ROW_RE = /T \d{3} [A-Z]{3}\t([\d,]+)/g;

function countTrucksWithRevenue(text) {
  let withRevenue = 0;
  let total = 0;
  let m;
  TRUCK_ROW_RE.lastIndex = 0;
  while ((m = TRUCK_ROW_RE.exec(text))) {
    total += 1;
    if (parseFloat(m[1].replace(/,/g, '')) > 0) withRevenue += 1;
  }
  return { withRevenue, total };
}

// Drills into a channel's truck-level breakdown to count how many trucks
// carried revenue > 0 that day — EAL Data Entry's "Available Trucks"/
// "Booked" columns (config.js) had no automated source at all before this
// (2026-09-13); both get this same count, since a truck that ran but posted
// zero revenue isn't meaningfully "available"/"booked" for the day's report.
// Same fresh-context-per-channel pattern as readBlendedGm and for the same
// reason (this dashboard's back-navigation doesn't reliably restore
// filter/period state after a drill-in), and the same
// read-until-two-consecutive-reads-agree stabilization.
//
// Deliberately fault-isolated: unlike readBlendedGm (whose failure already
// aborts/retries the whole scrape, a proven acceptable trade-off for a
// figure this pipeline has written since August), this is a brand new page
// interaction layered on top of an already-reliable revenue/GM/EBITDA
// pipeline — a truck-count hiccup logs and returns null rather than taking
// down everything else. A genuinely expired session is the one exception:
// that still needs to surface and trigger the normal re-link/retry path,
// not be swallowed as if it were a truck-read quirk.
async function readTruckCount(browser, filter, channelLabel) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    storageState: config.lcc.sessionStatePath,
  });
  try {
    const page = await context.newPage();
    await page.goto(config.lcc.url, { waitUntil: 'load', timeout: 30000 });
    if (
      (await waitForDashboardOrLogin(page, {
        dashboardSelector: config.lcc.selectors.filtersButton,
        loginSelector: config.lcc.selectors.loginPasswordInput,
      })) === 'login'
    ) {
      throw new SessionExpiredError('LCC session expired — redirected to login page.');
    }
    await filter.apply(page);
    await page.locator('text=' + channelLabel).first().click();

    // Two agreeing reads alone aren't enough: before the truck table renders,
    // two consecutive reads both see "0/0" and agree, and the drill-down
    // used to return 0 for a channel that really ran trucks (EAL Data Entry
    // showed 0/0 trucks for 2026-10-31 Transit at 61M revenue). The panel
    // states its own row count ("6 trucks active", confirmed live
    // 2026-11-09), so a read only counts once the parsed rows match it.
    let previous = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const text = await page.evaluate(() => document.body.innerText);
      const active = text.match(/(\d+) trucks? active/);
      const { withRevenue, total } = countTrucksWithRevenue(text);
      if (!active || Number(active[1]) !== total) {
        previous = null;
        continue;
      }
      const key = `${withRevenue}/${total}`;
      if (previous === key) return withRevenue;
      previous = key;
    }
    throw new Error(`Truck count for "${channelLabel}" never stabilized.`);
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    log(`LCC scraper: truck count for "${channelLabel}" unavailable — ${err.message}`);
    return null;
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
//
// Since the 2026-10-31 redesign the picker shows a single month, flanked by
// chevron buttons (lucide-chevron-right; the "previous" one is the same icon
// with rotate-180), confirmed live 2026-11-09. When the wanted month isn't
// showing, this steps toward it with those chevrons, up to 12 times.
const LCC_MONTH_CAPTION_RE = new RegExp(`^(${MONTH_NAMES.join('|')}) (\\d{4})$`);

function lccPanelLocator(page, label) {
  return page
    .locator('p', { hasText: new RegExp(`^${label}$`) })
    .locator('xpath=ancestor::div[contains(@class,"min-w-")]')
    .first();
}

async function lccCalendarMonthPanel(page, date) {
  const label = `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
  const wanted = date.getFullYear() * 12 + date.getMonth();
  for (let step = 0; step <= 12; step++) {
    const panel = lccPanelLocator(page, label);
    if (await panel.count()) return panel;
    const captions = await page.locator('p').allInnerTexts();
    const shown = captions.map((t) => t.trim().match(LCC_MONTH_CAPTION_RE)).find(Boolean);
    if (!shown) break;
    const shownIdx = Number(shown[2]) * 12 + MONTH_NAMES.indexOf(shown[1]);
    const chevron = wanted < shownIdx
      ? 'button:has(svg.lucide-chevron-right.rotate-180)'
      : 'button:has(svg.lucide-chevron-right:not(.rotate-180))';
    const calendar = page
      .locator('p', { hasText: LCC_MONTH_CAPTION_RE })
      .first()
      .locator('xpath=ancestor::div[.//button][1]');
    await calendar.locator(chevron).first().click();
    await page.waitForTimeout(400);
  }
  throw new Error(`LCC custom-date calendar couldn't navigate to "${label}".`);
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

async function scrapeLccOnceWithFilter(filter, runLabel, evidenceDate, { includeTruckCounts = false } = {}) {
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

    // Race the login form against the dashboard instead of counting password
    // inputs the instant goto() resolved — at `load` this SPA has rendered
    // neither, so that check passed on an expired session and the run then
    // died 15s later on the missing Filters button, mislabelling every
    // expiry as a selector timeout. See dashboardReady.js; this is the bug
    // that hid the 2026-09-08 EAL outage for two days.
    if (
      (await waitForDashboardOrLogin(page, {
        dashboardSelector: config.lcc.selectors.filtersButton,
        loginSelector: config.lcc.selectors.loginPasswordInput,
      })) === 'login'
    ) {
      throw new SessionExpiredError('LCC session expired — redirected to login page.');
    }
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

    // Trucks only make sense for a single day, and only for Transit/External
    // ("Other" has no truck concept) — see includeTruckCounts' callers below.
    if (includeTruckCounts) {
      for (const { label, key } of CHANNELS) {
        if (key === 'other') continue;
        channel[key].truckCount = await readTruckCount(browser, filter, label);
      }
    }

    return { revenue, grossMargin, ebitda, channel };
  } finally {
    await browser.close();
  }
}

async function scrapeLccWithRetry(filter, evidenceDate, runLabel, options) {
  const { attempts, delayMs } = config.lcc.retry;
  let lastErr;
  let relinked = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await scrapeLccOnceWithFilter(filter, runLabel, evidenceDate, options);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // Re-link once, in-run. This session expired overnight 2026-09-07→08
        // and every run failed until it was re-captured by hand on 09-09 —
        // two days of EAL reporting lost to a cookie with (going by the
        // 08-31 and 09-08 expiries) roughly a week's life. Login here is
        // unattended-safe: plain email/password, no 2FA (sessionCapture.js).
        // Guarded to one attempt so a wrong/locked credential fails the run
        // rather than hammering the login form.
        if (relinked) throw err;
        relinked = true;
        log('LCC scraper: session expired — re-capturing it and retrying.');
        try {
          await captureSession('lcc');
        } catch (captureErr) {
          log(`LCC scraper: session re-capture failed: ${captureErr.message}`);
          throw err;
        }
        attempt--; // the re-link shouldn't cost one of the transient-failure retries
        continue;
      }
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
//
// Truck counts (readTruckCount) are only meaningful for a single calendar
// day, so they're only requested for a non-MTD period — an "MTD truck count"
// isn't a real, useful figure (EAL Data Entry's Available Trucks/Booked are
// per-day columns), and skipping it there saves two extra page drill-ins on
// every MTD read.
async function scrapeLcc(period, targetDate, runLabel) {
  return scrapeLccWithRetry(periodFilter(period, targetDate), targetDate, runLabel, {
    includeTruckCounts: period !== 'MTD',
  });
}

// Scrapes the EAL Dashboard for an explicit start/end date range via the
// "Custom Date" filter — used for backfilling a specific past day (or range)
// that isn't reachable via the Yesterday/Today/MTD relative buttons. Pass
// the same date for start and end to read a single day. Same MTD-vs-daily
// reasoning as scrapeLcc above for whether truck counts are worth reading.
async function scrapeLccCustomRange(startDate, endDate, runLabel) {
  return scrapeLccWithRetry(customRangeFilter(startDate, endDate), endDate, runLabel, {
    includeTruckCounts: isoDateCompact(startDate) === isoDateCompact(endDate),
  });
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

module.exports = { scrapeLcc, scrapeLccCustomRange, findLccGaps, readKpiAndChannel, countTrucksWithRevenue };
