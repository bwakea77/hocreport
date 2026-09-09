// Decides whether a freshly loaded dashboard came up authenticated — and
// does it by *racing* the two possible outcomes rather than sampling one of
// them once.
//
// Both dashboards are SPAs. At `waitUntil: 'load'` the app shell exists but
// has rendered neither the dashboard nor the login form yet, so the previous
// check — count the password inputs the instant goto() resolved — read 0 on
// an expired session exactly as reliably as on a live one. The run then went
// on to fail 15s later waiting for a Filters button / date picker that was
// never coming, which meant:
//
//   * every expiry was reported as a selector timeout, so the "session
//     expired, re-run scripts/captureLccSession.js" alert in index.js
//     (alertLccFailure) could never fire, and
//   * because the error wasn't a SessionExpiredError, the retry loops
//     treated it as transient and burned all 4 attempts on it.
//
// That is what turned one expired EAL cookie into a silent two-day outage
// (2026-09-08 and -09, 28 failed attempts, see cron.log). Measured against
// the live EAL dashboard on 2026-09-09: password inputs = 0 at `load`, 1
// twenty seconds later.
//
// Polls login first on each pass, so a page that briefly renders both (login
// form behind a redirect that hasn't committed) is read as expired rather
// than as a usable dashboard.
async function waitForDashboardOrLogin(page, { dashboardSelector, loginSelector, timeoutMs = 30000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator(loginSelector).count()) return 'login';
    if (await page.locator(dashboardSelector).count()) return 'dashboard';
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(
    `Dashboard rendered neither its content ("${dashboardSelector}") nor a login form ("${loginSelector}") within ${timeoutMs}ms.`
  );
}

module.exports = { waitForDashboardOrLogin };
