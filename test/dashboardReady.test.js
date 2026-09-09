// Regression tests for the SPA login/dashboard race that turned an expired
// EAL session into a two-day silent outage on 2026-09-08. See
// dashboardReady.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForDashboardOrLogin } = require('../dashboardReady');

// Fake Playwright page whose selector counts change over successive polls,
// standing in for an SPA that renders nothing at `load` and settles later.
function fakePage(frames) {
  let i = 0;
  return {
    locator: (sel) => ({ count: async () => (frames[Math.min(i, frames.length - 1)][sel] ?? 0) }),
    waitForTimeout: async () => { i++; },
  };
}

const SELECTORS = { dashboardSelector: 'button:has-text("Filters")', loginSelector: 'input[type="password"]' };

test('reports an expired session even though nothing has rendered at load', async () => {
  // Measured against the live EAL dashboard 2026-09-09: password inputs = 0
  // the instant goto() resolves, 1 twenty seconds later. The old check
  // sampled only the first frame and so read an expired session as healthy.
  const page = fakePage([
    {},
    {},
    { 'input[type="password"]': 1 },
  ]);
  assert.equal(await waitForDashboardOrLogin(page, { ...SELECTORS, intervalMs: 0 }), 'login');
});

test('reports a healthy dashboard once its content renders', async () => {
  const page = fakePage([
    {},
    {},
    { 'button:has-text("Filters")': 1 },
  ]);
  assert.equal(await waitForDashboardOrLogin(page, { ...SELECTORS, intervalMs: 0 }), 'dashboard');
});

test('prefers login when a frame briefly shows both', async () => {
  // A redirect that has painted the login form while the old dashboard DOM
  // is still mounted must read as expired, not as a usable dashboard.
  const page = fakePage([{ 'button:has-text("Filters")': 1, 'input[type="password"]': 1 }]);
  assert.equal(await waitForDashboardOrLogin(page, { ...SELECTORS, intervalMs: 0 }), 'login');
});

test('throws when neither ever appears', async () => {
  const page = fakePage([{}]);
  await assert.rejects(
    () => waitForDashboardOrLogin(page, { ...SELECTORS, intervalMs: 0, timeoutMs: 30 }),
    /rendered neither its content .* nor a login form/
  );
});
