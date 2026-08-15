// One-time (re-run whenever the session expires) manual invocation:
//   node scripts/captureEafSession.js
// Logs into the EAF dashboard with the credentials in .env and persists the
// resulting cookies/storage to eaf-session.json, so the daily scraper never
// has to log in itself. Login is a plain username/password form (no
// 2FA/CAPTCHA, confirmed in §4 of the spec), so this runs headless like the
// daily scraper — set PLAYWRIGHT_HEADED=1 to watch it if you want to
// visually confirm the dashboard loads.
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('../config');
const { log } = require('../logger');

(async () => {
  const browser = await chromium.launch({ headless: !process.env.PLAYWRIGHT_HEADED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(config.eaf.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill(config.eaf.selectors.loginEmailInput, config.eaf.username);
    await page.fill(config.eaf.selectors.loginPasswordInput, config.eaf.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      page.click(config.eaf.selectors.loginSubmitButton),
    ]);
    await page.waitForTimeout(2000);

    if (/\/login/.test(page.url())) {
      throw new Error('Still on login page after submit — check credentials in .env.');
    }

    await context.storageState({ path: config.eaf.sessionStatePath });
    // storageState() writes with whatever the ambient umask allows — on this
    // host that has produced session files with inconsistent, sometimes
    // group/world-readable permissions. This file is a live-session bearer
    // credential (equivalent to the account's login), so lock it down
    // explicitly rather than depend on umask.
    fs.chmodSync(config.eaf.sessionStatePath, 0o600);
    log(`EAF session captured to ${config.eaf.sessionStatePath}`);
    console.log('Session captured successfully.');
  } finally {
    await browser.close();
  }
})();
