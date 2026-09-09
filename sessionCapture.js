// Logs into a dashboard with the credentials in .env and persists the
// resulting cookies/storage, so the daily scrapers never have to log in
// themselves.
//
// This used to live only inside scripts/capture{Eaf,Lcc}Session.js, which
// meant an expired session could only be repaired by a human noticing the
// alert and running one of those by hand. The EAL session died overnight
// 2026-09-07→08 and every run failed until someone did — two days of EAL
// reporting lost to a cookie. Both sites are plain email/password forms with
// no 2FA and no CAPTCHA (the same reason those scripts already ran headless),
// so the scrapers can re-link unattended; scrapeGm/scrapeLccWithRetry call
// this once per run on SessionExpiredError. The two scripts stay as the
// manual entry points and now just call in here.
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config');
const { log } = require('./logger');
const { waitForDashboardOrLogin } = require('./dashboardReady');

// Per-site bits that differ: viewport (matches what each scraper uses, so
// the captured session sees the same responsive layout) and the selector
// that proves the dashboard actually rendered post-login.
const SITES = {
  eaf: { viewport: { width: 1440, height: 900 }, dashboardSelector: (c) => c.selectors.dateRangeSelect },
  lcc: { viewport: { width: 1600, height: 1000 }, dashboardSelector: (c) => c.selectors.filtersButton },
};

async function captureSession(site) {
  const siteConfig = config[site];
  const { viewport, dashboardSelector } = SITES[site];
  if (!siteConfig) throw new Error(`Unknown session site "${site}".`);
  if (!siteConfig.username || !siteConfig.password) {
    throw new Error(`Missing ${site.toUpperCase()}_USERNAME/${site.toUpperCase()}_PASSWORD in .env — cannot capture a session.`);
  }

  const browser = await chromium.launch({ headless: !process.env.PLAYWRIGHT_HEADED });
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    await page.goto(siteConfig.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill(siteConfig.selectors.loginEmailInput, siteConfig.username);
    await page.fill(siteConfig.selectors.loginPasswordInput, siteConfig.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      page.click(siteConfig.selectors.loginSubmitButton),
    ]);

    // Same SPA race the scrapers hit (see dashboardReady.js): a fixed
    // waitForTimeout(2000) followed by one login-form check was reading the
    // gap between submit and first render, not the outcome of the login.
    const outcome = await waitForDashboardOrLogin(page, {
      dashboardSelector: dashboardSelector(siteConfig),
      loginSelector: siteConfig.selectors.loginPasswordInput,
    });
    if (outcome === 'login') {
      const errorText = await page.evaluate(() => document.body.innerText).catch(() => '');
      throw new Error(
        `Still on login page after submit — check ${site.toUpperCase()}_USERNAME/${site.toUpperCase()}_PASSWORD in .env. Page said: "${errorText.slice(0, 200)}"`
      );
    }

    await context.storageState({ path: siteConfig.sessionStatePath });
    // storageState() writes with whatever the ambient umask allows, which on
    // this host has produced session files with inconsistent, sometimes
    // group/world-readable permissions. This file is a live-session bearer
    // credential (equivalent to the account's login), so lock it down
    // explicitly rather than depend on umask.
    fs.chmodSync(siteConfig.sessionStatePath, 0o600);
    log(`${site.toUpperCase()} session captured to ${siteConfig.sessionStatePath}`);
  } finally {
    await browser.close();
  }
}

// Age of the persisted session in whole days, or null if there isn't one.
// Used only for the pre-flight warning in index.js — expiry is detected for
// real by waitForDashboardOrLogin, not guessed from mtime.
function sessionAgeDays(site) {
  const p = config[site]?.sessionStatePath;
  if (!p || !fs.existsSync(p)) return null;
  return Math.floor((Date.now() - fs.statSync(p).mtimeMs) / 86400000);
}

module.exports = { captureSession, sessionAgeDays };
