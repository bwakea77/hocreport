const config = require('./config');
const { getBranchRawRows, writeDailySnapshotGrid } = require('./sheetsClient');
const { computeBranchDailyMetrics } = require('./metrics');
const { log } = require('./logger');
// ISO (YYYY-MM-DD) rather than DD/MM/YYYY — the latter is ambiguous to
// Sheets' USER_ENTERED date parsing whenever the day is <=12 and the
// spreadsheet's locale isn't a DD/MM one (e.g. "05/08/2026" silently becomes
// May 8th instead of Aug 5th under a US locale). ISO has no such ambiguity.
const { isoDate: formatControlDate } = require('./dateUtils');

const TABLE_HEADER = [
  'Branch',
  'Product',
  'Total Revenue',
  'Avg Selling Price',
  'Total Discount',
  'Total Loadout',
  'Total Returns',
  'Gross Margin (Daily, %)',
  'Gross Margin (MTD, %)',
];

// null/undefined (missing/unparseable scrape, §5.3) renders as "-" rather
// than a guessed value, so the gap stays visible.
function gmCellValue(value) {
  if (value === null || value === undefined) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function buildDailySnapshotGrid(targetDate, metricsByBranch, gmByBranch) {
  const grid = [];

  grid.push(['Date:', formatControlDate(targetDate)]); // B1 = control date
  grid.push([]);
  grid.push(TABLE_HEADER.slice());

  // Company-wide GM, read straight off the dashboard's own top KPI card —
  // not a sum/average of the 4 branches below, which the dashboard may
  // weight differently. Revenue and discount are the one exception: those
  // two are summed across all branches for a same-day company-wide total.
  const overall = gmByBranch.OVERALL || {};
  let overallRevenue = 0;
  let overallDiscount = 0;
  for (const { sheetTab } of config.branches) {
    overallRevenue += metricsByBranch[sheetTab].total.totalRevenue;
    overallDiscount += metricsByBranch[sheetTab].total.totalDiscount;
  }
  grid.push(['OVERALL', '-', overallRevenue, '-', overallDiscount, '-', '-', gmCellValue(overall.daily), gmCellValue(overall.mtd)]);

  for (const { sheetTab } of config.branches) {
    const metrics = metricsByBranch[sheetTab];
    const gm = gmByBranch[sheetTab] || {};
    const dailyGm = gmCellValue(gm.daily);
    const mtdGm = gmCellValue(gm.mtd);

    // Variant is intentionally dropped from this flat view — a product sold
    // in two variants (e.g. 500ml/1L) shows as two same-named rows here,
    // distinguishable only by their numbers.
    for (const p of metrics.products) {
      grid.push([sheetTab, p.product, p.totalRevenue, p.avgSellingPrice, p.totalDiscount, p.totalLoadout, p.totalReturns, dailyGm, mtdGm]);
    }
  }

  return grid;
}

// Fetches raw rows for all 4 branches, computes yesterday's per-product
// metrics, merges in the scraped GM values, and writes the whole
// DAILY_SNAPSHOT tab in one shot. Returns diagnostics so the caller can alert
// on a run that "succeeded" but is missing data, not just on thrown errors:
// - branches whose raw tab fetch came back completely empty
// - branches/OVERALL with a missing GM figure
// - branches matching zero rows for the target date despite having raw data
//   fetched at all — surfaced individually by name, with a distinct message
//   when it's all 4 at once (which usually means the upstream raw data for
//   that date hasn't landed yet, rather than 4 branches independently and
//   coincidentally having nothing to report)
// - branches whose raw tab header no longer lines up with config.js's
//   rawColumns mapping (validateColumnLayout in metrics.js)
async function runDailySnapshot(sheets, targetDate, gmByBranch) {
  const metricsByBranch = {};
  const emptyRawBranches = [];
  const zeroProductBranches = [];
  for (const { sheetTab } of config.branches) {
    const rows = await getBranchRawRows(sheets, sheetTab);
    if (rows.length === 0) emptyRawBranches.push(sheetTab);
    metricsByBranch[sheetTab] = computeBranchDailyMetrics(rows, sheetTab, targetDate);
    if (rows.length > 0 && metricsByBranch[sheetTab].products.length === 0) {
      zeroProductBranches.push(sheetTab);
    }
    log(
      `Metrics: ${sheetTab} — ${rows.length} raw row(s) fetched, ${metricsByBranch[sheetTab].products.length} product line(s) for target date`
    );
  }
  const allBranchesZeroProducts = zeroProductBranches.length === config.branches.length;

  const missingGm = [];
  for (const key of ['OVERALL', ...config.branches.map((b) => b.sheetTab)]) {
    const gm = gmByBranch[key];
    if (!gm || gm.daily === null || gm.daily === undefined || gm.mtd === null || gm.mtd === undefined) {
      missingGm.push(key);
    }
  }

  const columnLayoutBranches = config.branches
    .map((b) => b.sheetTab)
    .filter((sheetTab) => metricsByBranch[sheetTab].columnLayoutIssues.length > 0);

  const grid = buildDailySnapshotGrid(targetDate, metricsByBranch, gmByBranch);
  await writeDailySnapshotGrid(sheets, grid);

  return { emptyRawBranches, missingGm, allBranchesZeroProducts, zeroProductBranches, columnLayoutBranches, metricsByBranch };
}

module.exports = { buildDailySnapshotGrid, runDailySnapshot };
