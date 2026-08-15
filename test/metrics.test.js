const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const { parseNumber, sheetDateToIso, dateToIso, computeBranchDailyMetrics } = require('../metrics');

const ROW_WIDTH = 34; // covers config.sheets.rawColumns' highest index (discount, AH/33)

function headerRow() {
  const row = new Array(ROW_WIDTH).fill('');
  for (const [name, idx] of Object.entries(config.sheets.rawColumns)) {
    row[idx] = config.sheets.rawColumnLabels[name];
  }
  return row;
}

function dataRow({ date, product, variant = '', loadOut = '', returns = '', qtySold = '', netSales = '', discount = '' }) {
  const row = new Array(ROW_WIDTH).fill('');
  const cols = config.sheets.rawColumns;
  row[cols.date] = date;
  row[cols.product] = product;
  row[cols.variant] = variant;
  row[cols.loadOut] = loadOut;
  row[cols.returns] = returns;
  row[cols.qtySold] = qtySold;
  row[cols.netSales] = netSales;
  row[cols.discount] = discount;
  return row;
}

test('parseNumber handles blanks, commas, and accounting-negatives', () => {
  assert.equal(parseNumber(''), 0);
  assert.equal(parseNumber(undefined), 0);
  assert.equal(parseNumber(null), 0);
  assert.equal(parseNumber(' 1,082,000'), 1082000);
  assert.equal(parseNumber('(20,000)'), -20000);
  assert.equal(parseNumber('not a number', { branch: 'X', column: 'y', sheetRow: 1 }), 0);
});

test('sheetDateToIso parses "12-Aug-2026" and rejects non-dates', () => {
  assert.equal(sheetDateToIso('12-Aug-2026'), '2026-08-12');
  assert.equal(sheetDateToIso('Date'), null);
  assert.equal(sheetDateToIso(''), null);
  assert.equal(sheetDateToIso(undefined), null);
});

test('dateToIso matches sheetDateToIso for the same calendar day', () => {
  assert.equal(dateToIso(new Date(2026, 7, 12)), '2026-08-12');
});

test('computeBranchDailyMetrics groups by product+variant case-insensitively, for the target date only', () => {
  const targetDate = new Date(2026, 7, 12);
  const rows = [
    [],
    [],
    [],
    headerRow(),
    dataRow({ date: '12-Aug-2026', product: 'Milk', variant: '500ml', netSales: '1,000', qtySold: '2', loadOut: '3', returns: '0', discount: '(100)' }),
    dataRow({ date: '12-Aug-2026', product: 'milk', variant: '500ML', netSales: '500', qtySold: '1', loadOut: '1', returns: '0', discount: '0' }),
    dataRow({ date: '11-Aug-2026', product: 'Milk', variant: '500ml', netSales: '9999', qtySold: '9', loadOut: '9', returns: '0', discount: '0' }),
  ];

  const { products, total, columnLayoutIssues } = computeBranchDailyMetrics(rows, 'BUNJU', targetDate);

  assert.equal(columnLayoutIssues.length, 0);
  assert.equal(products.length, 1); // the two Aug-12 rows merge despite differing case
  assert.equal(products[0].product, 'Milk'); // keeps first-seen casing for display
  assert.equal(products[0].totalRevenue, 1500);
  assert.equal(products[0].totalQtySold, 3);
  assert.equal(products[0].totalDiscount, -100);
  assert.equal(total.totalRevenue, 1500); // the Aug-11 row is excluded entirely
});

test('computeBranchDailyMetrics collapses ONJA to a single "Rice" line regardless of product/variant', () => {
  const targetDate = new Date(2026, 7, 12);
  const rows = [
    [],
    [],
    [],
    headerRow(),
    dataRow({ date: '12-Aug-2026', product: 'Basmati', variant: '5kg', netSales: '1000', qtySold: '1' }),
    dataRow({ date: '12-Aug-2026', product: 'Pishori', variant: '10kg', netSales: '2000', qtySold: '2' }),
  ];
  const { products } = computeBranchDailyMetrics(rows, 'ONJA', targetDate);
  assert.equal(products.length, 1);
  assert.equal(products[0].product, 'Rice');
  assert.equal(products[0].totalRevenue, 3000);
});

test('computeBranchDailyMetrics flags a shifted column layout by name', () => {
  const targetDate = new Date(2026, 7, 12);
  const badHeader = headerRow();
  badHeader[config.sheets.rawColumns.netSales] = 'Something Else';
  const rows = [[], [], [], badHeader];
  const { columnLayoutIssues } = computeBranchDailyMetrics(rows, 'BUNJU', targetDate);
  assert.deepEqual(columnLayoutIssues, ['netSales']);
});
