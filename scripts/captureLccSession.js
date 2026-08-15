// One-time (re-run whenever the session expires) manual invocation:
//   node scripts/captureLccSession.js
// Logs into the EAL Dashboard (lcc.eafoods.com, Transport P&L) with the
// credentials in .env and persists the resulting cookies/storage to
// lcc-session.json, so the daily scraper never has to log in itself. Login
// is a plain email/password form (no 2FA/CAPTCHA observed), so this runs
// headless like the daily scraper — set PLAYWRIGHT_HEADED=1 to watch it if
// you want to visually confirm the dashboard loads.
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('../config');
const { log } = require('../logger');

(async () => {
  const browser = await chromium.launch({ headless: !process.env.PLAYWRIGHT_HEADED });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  try {
    await page.goto(config.lcc.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill(config.lcc.selectors.loginEmailInput, config.lcc.username);
    await page.fill(config.lcc.selectors.loginPasswordInput, config.lcc.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      page.click(config.lcc.selectors.loginSubmitButton),
    ]);
    await page.waitForTimeout(2000);

    const stillOnLogin = await page.locator(config.lcc.selectors.loginPasswordInput).count();
    if (stillOnLogin > 0) {
      const errorText = await page.evaluate(() => document.body.innerText).catch(() => '');
      throw new Error(
        `Still on login page after submit — check LCC_USERNAME/LCC_PASSWORD in .env. Page said: "${errorText.slice(0, 200)}"`
      );
    }

    await context.storageState({ path: config.lcc.sessionStatePath });
    // storageState() writes with whatever the ambient umask allows — this is
    // exactly why eaf-session.json and lcc-session.json ended up with
    // different (one group/world-readable) permissions on this host despite
    // holding equivalently sensitive live-session credentials. Lock it down
    // explicitly instead of depending on umask.
    fs.chmodSync(config.lcc.sessionStatePath, 0o600);
    log(`LCC session captured to ${config.lcc.sessionStatePath}`);
    console.log('Session captured successfully.');
  } finally {
    await browser.close();
  }
})();
