require('dotenv').config();
const path = require('path');

module.exports = {
  eaf: {
    url: process.env.EAF_URL,
    username: process.env.EAF_USERNAME,
    password: process.env.EAF_PASSWORD,
    sessionStatePath: path.join(__dirname, 'eaf-session.json'),
    // Captured 2026-08-13 from the live dashboard (React SPA, no stable
    // name/id/data-testid attributes — these are the most specific selectors
    // available). Re-verify with scripts/captureEafSession.js if the site's
    // markup changes and the scraper starts failing.
    selectors: {
      loginEmailInput: 'input[type="email"]',
      loginPasswordInput: 'input[type="password"]',
      loginSubmitButton: 'button[type="submit"]',
      // Single <select> in the header controls the date range.
      dateRangeSelect: 'select',
      // <option value="custom"> opens the react-day-picker range calendar
      // instead of relying on the "Today"/"This Month" presets, which are
      // ambiguous about which calendar day they mean and depend on when the
      // script happens to run — explicit dates are deterministic.
      customRangeOptionValue: 'custom',
      calendarMonthCaption: '[aria-live="polite"][role="presentation"]',
      calendarPrevMonthButton: 'button[name="previous-month"]',
      calendarNextMonthButton: 'button[name="next-month"]',
      // Outside-month days (trailing/leading days shown in the grid) get an
      // extra "day-outside" class — excluded so e.g. clicking "1" always
      // hits the in-view month's 1st, never next/previous month's.
      calendarDayButton: 'button[name="day"]:not(.day-outside)',
      applyFilterButton: 'button:has-text("Apply Filter")',
      // Branches Performance is the default/only visible tab on load.
      branchesPerformanceTab: 'button:has-text("Branches Performance")',
      // The Branches Performance table is the only <table> on the page.
      branchTableRows: 'table tbody tr',
      // Within a row, GM is the 4th <td> (0-indexed: 3) — rank, branch,
      // achievement score, GM, return rate, discount, net utilization, chevron.
      gmCellIndexInRow: 3,
      // Branch name is the 2nd <td> (0-indexed: 1) — read and exact-matched
      // against config.branches[].dashboardName rather than relying on
      // Playwright's substring hasText match against the whole row, which
      // would mismatch if a future branch name were ever a substring of
      // another's.
      branchNameCellIndexInRow: 1,
    },
    // The dashboard is occasionally slow/flaky to load (observed: stuck
    // "Loading dashboard..." screen, transient DNS/network blips) — retry
    // the whole scrape with a fresh browser rather than fail the run over
    // what's usually a transient hiccup, not a real problem.
    retry: {
      attempts: 4,
      delayMs: 3000,
    },
  },

  // EAL Dashboard (lcc.eafoods.com) — Transport P&L site, second scrape
  // target added alongside the EAF Sales Command Center above. Same
  // React-SPA-with-no-stable-attributes situation as EAF, so selectors here
  // are similarly structural/text-based. Captured 2026-08-14.
  lcc: {
    url: process.env.LCC_URL,
    username: process.env.LCC_USERNAME,
    password: process.env.LCC_PASSWORD,
    sessionStatePath: path.join(__dirname, 'lcc-session.json'),
    selectors: {
      loginEmailInput: 'input[type="email"]',
      loginPasswordInput: 'input[type="password"]',
      loginSubmitButton: 'button[type="submit"]',
      // Top-bar "Filters" dropdown holds the PERIOD selector (MTD/Today/
      // Yesterday/Last 7 Days/Last 30 Days/Custom Date).
      filtersButton: 'button:has-text("Filters")',
      periodButton: (label) => `button:has-text("${label}")`,
    },
    retry: {
      attempts: 4,
      delayMs: 3000,
    },
  },

  branches: [
    { dashboardName: 'Bunju', sheetTab: 'BUNJU', hocReportsLabel: 'Bunju' },
    { dashboardName: 'Dodoma', sheetTab: 'DODOMA', hocReportsLabel: 'Dodoma' },
    { dashboardName: 'Kinyerezi', sheetTab: 'KINYEREZI', hocReportsLabel: 'Kinyerezi' },
    { dashboardName: 'Onja Channel', sheetTab: 'ONJA', hocReportsLabel: 'Onja' },
  ],

  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    serviceAccountKeyPath: process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      : path.join(__dirname, 'service-account.json'),
    dailySnapshotTab: 'DAILY_SNAPSHOT',
    lccSnapshotTab: 'LCC_SNAPSHOT',
    // Bounded per §2.3's IMPORTRANGE-ballooning gotcha — also generously
    // covers the stray-SNO rows observed past the real data extent.
    rawDataRange: 'A1:AJ30000',
    // 0-indexed row index of the real per-column header labels ("SNO.",
    // "Date", "Product", ...) within a raw branch tab, confirmed 2026-08-13
    // against BUNJU/DODOMA/KINYEREZI/ONJA. Rows 0 and 2 are blank spacer
    // rows and row 1 is a sparse group super-header ("ROUTE DETAILS>>>",
    // "SALES>>>", ...) with no labels at most column indices — checking
    // row 0 (as this used to) would always find it blank and warn on every
    // run regardless of the real layout.
    headerRowIndex: 3,
    // 0-indexed column positions within a raw branch-tab row (§2.2 map),
    // confirmed 2026-08-13 against the live BUNJU tab header row.
    rawColumns: {
      date: 2, // C
      product: 10, // K
      variant: 11, // L
      loadOut: 13, // N
      returns: 16, // Q
      qtySold: 18, // S
      netSales: 20, // U
      discount: 33, // AH
    },
    // Exact header text at each of the indices above, confirmed 2026-08-14
    // via a live read of BUNJU/DODOMA/KINYEREZI/ONJA's header row (identical
    // across all four). validateColumnLayout (metrics.js) compares against
    // these rather than just checking the cell is non-blank, so a column
    // shift that happens to land on other non-blank text (not just a blank
    // gap) is still caught.
    rawColumnLabels: {
      date: 'Date',
      product: 'Product',
      variant: 'Product Variant',
      loadOut: 'Total Load Out',
      returns: 'Return',
      qtySold: 'Qty Sold',
      netSales: 'Total Net Sales',
      discount: 'Total Discount',
    },
  },

  // HOC-REPORTS-final workbook — a separate, broader reporting spreadsheet
  // (not the master one above) with manual-entry logs the user's team reads
  // from. This pipeline appends yesterday's row(s) alongside their existing
  // manual entries rather than owning/rewriting the tab.
  hocReports: {
    spreadsheetId: process.env.HOC_REPORTS_SPREADSHEET_ID,
    dataEntryTab: 'EAF Data Entry',
    gmEbitdaEntryTab: 'EAF GM & EBITDA Entry',
    // Transport P&L (LCC-scraped) manual-entry log — mirrors EAF Data Entry's
    // "date + label" row shape but with LCC's own segments/columns. Confirmed
    // 2026-08-14 live against the sheet: A=Date, B=Segment, C=Revenue,
    // D=Amount Collected, E=GM %, F=EBITDA %, G=Available Trucks, H=Booked,
    // I=blank spacer, J=fixed "Segment Options" dropdown source list.
    ealDataEntryTab: 'EAL Data Entry',
    // MTD counterpart to ealDataEntryTab, mirroring EAF GM & EBITDA Entry's
    // role on the EAF side — created 2026-08-14 specifically so EAL-MORN/
    // EAL-EOD's MTD GM%/EBITDA% lookups read a real scraped MTD figure
    // instead of reusing EAL Data Entry's daily Overall row as a stand-in.
    // A=Date, B=Segment, C=MTD GM %, D=MTD EBITDA % (Overall only — no
    // per-channel EBITDA exists on the LCC dashboard), E=blank spacer,
    // F=fixed "Segment Options" dropdown source list.
    ealGmEbitdaEntryTab: 'EAL GM & EBITDA Entry',
  },

  // Zoho Mail SMTP — mirrors the Slack alert channel (same events, same
  // dashboard images) delivered to an inbox instead. Self-send: EMAIL_USER
  // both authenticates and receives, unless EMAIL_TO is set separately.
  email: {
    smtpHost: process.env.EMAIL_SMTP_HOST || 'smtp.zoho.com',
    smtpPort: process.env.EMAIL_SMTP_PORT ? parseInt(process.env.EMAIL_SMTP_PORT, 10) : 465,
    smtpSecure: process.env.EMAIL_SMTP_SECURE ? process.env.EMAIL_SMTP_SECURE !== 'false' : true,
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASSWORD,
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: process.env.EMAIL_TO || process.env.EMAIL_USER,
  },

  slack: {
    // Incoming Webhook URL — Slack app -> Incoming Webhooks -> Add New
    // Webhook to Workspace. Posts to whichever channel the webhook was
    // created for; see README's Slack setup section. Text alerts only —
    // Incoming Webhooks can't upload files.
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
    // Bot User OAuth Token (files:write + chat:write scopes) on the same
    // Slack app — required for dashboard-image uploads (slackFiles.js), a
    // platform-level requirement since Incoming Webhooks can't post files.
    botToken: process.env.SLACK_BOT_TOKEN,
    // Channel ID (not name) the bot posts uploaded images into — the bot
    // user must be a member of this channel. Normally the same channel the
    // webhook above posts text alerts into.
    channelId: process.env.SLACK_CHANNEL_ID,
  },

  // Dashboard-tab screenshots posted to Slack alongside each run's text
  // alert (sheetImage.js/slackFiles.js) — separate from the raw data tabs
  // this pipeline writes (DAILY_SNAPSHOT/LCC_SNAPSHOT/HOC-REPORTS-final):
  // these are human-built dashboard views on top of that data, already
  // referenced elsewhere in this file (e.g. the EAF tab's K22, EAL-MORN/
  // EAL-EOD's MTD lookups above) but never previously read by this pipeline.
  sheetImages: {
    // No separate credential/session here — sheetImage.js authenticates the
    // range-export download as the same sheets-writer service account every
    // other Sheets API call in this file already uses (serviceAccountKeyPath
    // above), rather than needing a real Google account's browser login.
    outputDir: path.join(__dirname, 'sheet-images'),
    // { tab, range } captured after each run type's writes complete;
    // spreadsheetId defaults to sheets.spreadsheetId (master) unless a
    // target overrides it — EAF/EAL-MORN/EAL-EOD all live in
    // HOC-REPORTS-final instead (confirmed live 2026-08-15 against the
    // actual spreadsheets: they sit alongside EAF Data Entry/EAL Data Entry,
    // not DAILY_SNAPSHOT), hence the override on every entry below. Ranges
    // are plain A1 notation (no sheet-name prefix).
    targets: {
      morning: [
        // 05:00 (primary) and 05:30 (verify) — both "EAF morning" runs.
        { tab: 'EAF', range: 'D2:Q46', spreadsheetId: process.env.HOC_REPORTS_SPREADSHEET_ID },
        { tab: 'EAL-MORN', range: 'E8:P29', spreadsheetId: process.env.HOC_REPORTS_SPREADSHEET_ID },
      ],
      eod: [
        // 16:25 — LCC-only EOD run.
        { tab: 'EAL-EOD', range: 'E6:K28', spreadsheetId: process.env.HOC_REPORTS_SPREADSHEET_ID },
      ],
    },
  },

  logging: {
    filePath: path.join(__dirname, 'run.log'),
  },
};
