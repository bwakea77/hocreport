const config = require('./config');
const { log } = require('./logger');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Raw cells look like " 1,082,000", "(20,000)" (accounting-negative), or "".
// `context` (branch/column/sheetRow) is only used to log when a non-empty
// cell fails to parse — a silent 0 there would corrupt totals with no trace,
// e.g. if the raw tab's column layout ever shifts.
function parseNumber(raw, context) {
  if (raw === undefined || raw === null) return 0;
  const trimmed = String(raw).trim();
  if (!trimmed) return 0;
  const negative = trimmed.startsWith('(') && trimmed.endsWith(')');
  const num = parseFloat(trimmed.replace(/[(),]/g, ''));
  if (Number.isNaN(num)) {
    if (context) {
      log(
        `Metrics: unparseable ${context.column} value "${raw}" in ${context.branch} row ${context.sheetRow} — treating as 0.`
      );
    }
    return 0;
  }
  return negative ? -Math.abs(num) : num;
}

// Checks that the configured column indices still line up with the raw
// tab's header row — catches a shifted rawColumns mapping (config.js) before
// it silently zeroes out every downstream number via parseNumber. Compares
// against the exact expected label (config.sheets.rawColumnLabels), not just
// "is the cell non-blank" — a shift that lands on some other non-blank
// header text (e.g. everything shifted one column right) previously passed
// this check silently since every cell was still non-empty. Returns the
// names of columns that failed the check (empty if none) so the caller can
// surface a drift beyond just this log line.
function validateColumnLayout(rows, branchSheetTab) {
  const header = rows[config.sheets.headerRowIndex];
  if (!header) return [];
  const issues = [];
  for (const [name, idx] of Object.entries(config.sheets.rawColumns)) {
    const actual = String(header[idx] || '').trim();
    const expected = config.sheets.rawColumnLabels[name];
    if (!actual) {
      log(
        `Metrics: WARNING — ${branchSheetTab} header row has no label at column index ${idx} (expected "${expected}" for "${name}"); raw column layout may have shifted.`
      );
      issues.push(name);
    } else if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
      log(
        `Metrics: WARNING — ${branchSheetTab} header row at column index ${idx} reads "${actual}", expected "${expected}" for "${name}"; raw column layout may have shifted.`
      );
      issues.push(name);
    }
  }
  return issues;
}

// Raw dates look like "12-Aug-2026" — not the DD/MM/YYYY the spec assumed.
function sheetDateToIso(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const monthIdx = MONTHS.indexOf(m[2]);
  if (monthIdx === -1) return null;
  return `${m[3]}-${String(monthIdx + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function dateToIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Groups a branch's raw rows by Product+Variant (§2.4) for the target date
// and computes the metrics the user asked for. ONJA is force-labeled "Rice"
// and fully collapsed across variants for this daily view (§2.4).
function computeBranchDailyMetrics(rows, branchSheetTab, targetDate) {
  const targetIso = dateToIso(targetDate);
  const cols = config.sheets.rawColumns;
  const groups = new Map();
  const totals = { netSales: 0, qtySold: 0, discount: 0, loadOut: 0, returns: 0, rowCount: 0 };

  const columnLayoutIssues = validateColumnLayout(rows, branchSheetTab);
  const warnedDates = new Set();

  // Rows above and including headerRowIndex are structurally never data
  // (blank spacers, the group super-header, the header row itself) — the
  // header row's own date cell literally reads "Date", which would
  // otherwise trip the unparseable-date warning below on every single run.
  for (let i = config.sheets.headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const rowIso = sheetDateToIso(row[cols.date]);
    if (rowIso === null) {
      // Distinct from "this row is for some other date" (the overwhelming
      // majority of rows, never worth logging) — this is a date cell that
      // didn't parse as a date AT ALL, which usually means the upstream
      // date format changed and this row (and likely many siblings) is
      // silently falling out of every total with no other trace. Logged at
      // most once per distinct malformed value to avoid flooding run.log.
      const rawDate = row[cols.date];
      const trimmed = rawDate === undefined || rawDate === null ? '' : String(rawDate).trim();
      if (trimmed && !warnedDates.has(trimmed)) {
        warnedDates.add(trimmed);
        log(`Metrics: unparseable date "${trimmed}" in ${branchSheetTab} row ${i + 1} — row excluded from all totals.`);
      }
      continue;
    }
    if (rowIso !== targetIso) continue;

    const rawProduct = (row[cols.product] || '').toString().trim();
    const rawVariant = (row[cols.variant] || '').toString().trim();
    if (!rawProduct && !rawVariant) continue;

    const sheetRow = i + 1;
    const ctx = (column) => ({ branch: branchSheetTab, column, sheetRow });
    const netSales = parseNumber(row[cols.netSales], ctx('netSales'));
    const qtySold = parseNumber(row[cols.qtySold], ctx('qtySold'));
    const discount = parseNumber(row[cols.discount], ctx('discount'));
    const loadOut = parseNumber(row[cols.loadOut], ctx('loadOut'));
    const returns = parseNumber(row[cols.returns], ctx('returns'));

    const isOnja = branchSheetTab === 'ONJA';
    const product = isOnja ? 'Rice' : rawProduct;
    const variant = isOnja ? '' : rawVariant;
    // Case-insensitive key — matches hocReportsEntry.js's sumDodomaProduct,
    // which merges "Banana"/"banana" together when building HOC-REPORTS-final.
    // Grouping case-sensitively here would let a stray casing variant upstream
    // split into two separate DAILY_SNAPSHOT rows while HOC-REPORTS-final
    // silently merged them into one, showing two different totals for what's
    // really the same product. Display keeps the first-seen row's casing.
    const key = isOnja ? 'Rice' : `${product.toLowerCase()}|${variant.toLowerCase()}`;

    if (!groups.has(key)) {
      groups.set(key, { product, variant, netSales: 0, qtySold: 0, discount: 0, loadOut: 0, returns: 0, rowCount: 0 });
    }
    const g = groups.get(key);
    g.netSales += netSales;
    g.qtySold += qtySold;
    g.discount += discount;
    g.loadOut += loadOut;
    g.returns += returns;
    g.rowCount += 1;

    totals.netSales += netSales;
    totals.qtySold += qtySold;
    totals.discount += discount;
    totals.loadOut += loadOut;
    totals.returns += returns;
    totals.rowCount += 1;
  }

  const products = Array.from(groups.values())
    .sort((a, b) => (a.product + a.variant).localeCompare(b.product + b.variant))
    .map((g) => ({
      product: g.product,
      variant: g.variant,
      totalRevenue: g.netSales,
      totalQtySold: g.qtySold,
      avgSellingPrice: g.qtySold ? g.netSales / g.qtySold : 0,
      totalDiscount: g.discount,
      avgLoadoutQty: g.rowCount ? g.loadOut / g.rowCount : 0,
      totalLoadout: g.loadOut,
      totalReturns: g.returns,
    }));

  const total = {
    totalRevenue: totals.netSales,
    avgSellingPrice: totals.qtySold ? totals.netSales / totals.qtySold : 0,
    totalDiscount: totals.discount,
    avgLoadoutQty: totals.rowCount ? totals.loadOut / totals.rowCount : 0,
    totalLoadout: totals.loadOut,
    totalReturns: totals.returns,
  };

  return { products, total, columnLayoutIssues };
}

module.exports = { parseNumber, sheetDateToIso, dateToIso, computeBranchDailyMetrics };
