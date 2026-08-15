const config = require('./config');
const { log } = require('./logger');
const { isoDate, dateToSerial } = require('./dateUtils');
const {
  getSheetId,
  scanExistingRows,
  insertRowsAfter,
  blankRow,
  applyColumnFormats,
  collectCellUpdate,
  applyBatchUpdate,
} = require('./manualEntryRows');
const { withRetryOnce } = require('./retry');

// Column-index number formats for EAF Data Entry / EAF GM & EBITDA Entry's
// newly-inserted rows — applied explicitly after every insert, mirroring the
// fix ealReportsEntry.js already applies to EAL Data Entry/EAL GM & EBITDA
// Entry (see applyColumnFormats in manualEntryRows.js for why:
// insertRowsAfter's inheritFromBefore only copies formatting from the row
// immediately above the insertion point, which is the plain-text header row
// — not a real data row — on a tab's very first-ever automated insert).
// Column indices are 0-based absolute sheet columns (A=0, B=1, ...), matching
// buildDataEntryRows/buildGmEbitdaRows' row layout below.
const EAF_DATA_ENTRY_FORMATS = [
  { startCol: 0, endCol: 1, numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } }, // A Date
  { startCol: 2, endCol: 3, numberFormat: { type: 'NUMBER', pattern: '#,##0' } }, // C Revenue
  { startCol: 3, endCol: 4, numberFormat: { type: 'PERCENT', pattern: '0.0%' } }, // D GM %
  { startCol: 5, endCol: 9, numberFormat: { type: 'NUMBER', pattern: '#,##0' } }, // F-I ASP/Returns/Discount/Loadout
  { startCol: 9, endCol: 13, numberFormat: { type: 'NUMBER', pattern: '#,##0' } }, // J-M Dodoma Banana/Potato revenue+loadout
  { startCol: 17, endCol: 20, numberFormat: { type: 'NUMBER', pattern: '#,##0' } }, // R-T Dodoma Banana ASP/returns/discount
  { startCol: 21, endCol: 24, numberFormat: { type: 'NUMBER', pattern: '#,##0' } }, // V-X Dodoma Potato ASP/returns/discount
];
const EAF_GM_EBITDA_FORMATS = [
  { startCol: 0, endCol: 1, numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } }, // A Date
  { startCol: 2, endCol: 4, numberFormat: { type: 'PERCENT', pattern: '0.0%' } }, // C/D GM %, EBITDA %
];

// Sums a Dodoma product's figures across any matching (case-insensitive)
// product groups — normally exactly one, but robust to a stray extra variant
// row under the same product name. ASP is recomputed as a weighted average
// using the actual summed qty sold (metrics.js's totalQtySold) rather than
// reconstructing qty from revenue/ASP — reconstructing it that way silently
// dropped a group's quantity whenever its net sales netted to exactly 0
// (e.g. a fully-returned batch) despite units having been sold, since
// avgSellingPrice is 0 in that case, understating qty and inflating the
// combined ASP written into HOC-REPORTS-final.
function sumDodomaProduct(products, productName) {
  const matches = products.filter((p) => p.product.toLowerCase() === productName.toLowerCase());
  let revenue = 0;
  let qtySold = 0;
  let discount = 0;
  let loadout = 0;
  let returns = 0;
  for (const p of matches) {
    revenue += p.totalRevenue;
    qtySold += p.totalQtySold;
    discount += p.totalDiscount;
    loadout += p.totalLoadout;
    returns += p.totalReturns;
  }
  return {
    revenue,
    loadout,
    returns,
    discount,
    asp: qtySold ? revenue / qtySold : 0,
  };
}

const DATA_ENTRY_BRANCH_ORDER = ['BUNJU', 'KINYEREZI', 'DODOMA', 'ONJA'];
const DATA_ENTRY_ROW_ORDER = [...DATA_ENTRY_BRANCH_ORDER, 'OVERALL'];
const HOC_LABEL_BY_SHEET_TAB = Object.fromEntries(
  config.branches.map((b) => [b.sheetTab, b.hocReportsLabel])
);
const dataEntryLabelFor = (sheetTab) => (sheetTab === 'OVERALL' ? 'Overall' : HOC_LABEL_BY_SHEET_TAB[sheetTab]);

// Builds one row per branch (+ an Overall row) for EAF Data Entry (A:N, then
// Q:X for Dodoma's Banana/Potato breakdown — columns O and P are left
// untouched: O is a blank spacer, P is the fixed "Branch Options" dropdown
// source list). The Overall row only ever gets column D (daily GM %) filled
// — its revenue/ASP/etc. are already derived elsewhere in the EAF tab via
// SUM() of the 4 branch rows, so there's nothing to put in C/F/G/H/I. It
// exists so the "Branch Yesterday's Performance" table's Overall GM% (EAF
// tab K22) can do the same exact-date lookup against this sheet that the 4
// real branches already use, instead of pulling MTD out of EAF GM & EBITDA
// Entry by mistake.
function buildDataEntryRows(targetDate, metricsByBranch, gmByBranch, existingKeys) {
  const dateSerial = dateToSerial(targetDate);
  const rowsAN = [];
  const rowsQX = [];
  const branchesWritten = [];

  for (const sheetTab of DATA_ENTRY_ROW_ORDER) {
    const label = dataEntryLabelFor(sheetTab);
    if (existingKeys.has(`${dateSerial}|${label}`)) {
      log(`hocReportsEntry: EAF Data Entry already has a ${label} row for ${isoDate(targetDate)} — skipping.`);
      continue;
    }

    const gm = gmByBranch[sheetTab] || {};
    const dailyGm = gm.daily === null || gm.daily === undefined ? '' : gm.daily;

    const rowAN = blankRow(14); // A..N
    rowAN[0] = isoDate(targetDate); // A Date
    rowAN[1] = label; // B Branch
    rowAN[3] = dailyGm; // D GM %
    // E EBITDA % — no automated source, left blank.

    const rowQX = blankRow(8); // Q..X

    if (sheetTab === 'OVERALL') {
      // C/F/G/H/I intentionally left blank — see function comment above.
    } else if (sheetTab === 'DODOMA') {
      const metrics = metricsByBranch[sheetTab];
      const banana = sumDodomaProduct(metrics.products, 'Banana');
      const potato = sumDodomaProduct(metrics.products, 'Potato');
      rowAN[2] = '=J{r}+L{r}'; // placeholder, replaced with the real row number below
      rowAN[8] = '=K{r}+M{r}';
      rowAN[7] = '=T{r}+X{r}';
      // F (ASP) and G (Returns) intentionally left blank for Dodoma — per
      // the sheet's own note, those live at the product level (R/V, S/W)
      // only, never combined.
      rowAN[9] = banana.revenue; // J
      rowAN[10] = banana.loadout; // K
      rowAN[11] = potato.revenue; // L
      rowAN[12] = potato.loadout; // M
      // Q/U (per-product GM %) have no automated source — left blank for
      // manual entry, matching every historical Dodoma row.
      rowQX[1] = banana.asp; // R
      rowQX[2] = banana.returns; // S
      rowQX[3] = banana.discount ? -banana.discount : 0; // T (flip to positive convention)
      rowQX[5] = potato.asp; // V
      rowQX[6] = potato.returns; // W
      rowQX[7] = potato.discount ? -potato.discount : 0; // X
    } else {
      const total = metricsByBranch[sheetTab].total;
      rowAN[2] = total.totalRevenue; // C
      rowAN[5] = total.avgSellingPrice; // F
      rowAN[6] = total.totalReturns; // G
      rowAN[7] = total.totalDiscount ? -total.totalDiscount : 0; // H (flip to positive convention)
      rowAN[8] = total.totalLoadout; // I
    }

    rowsAN.push(rowAN);
    rowsQX.push(rowQX);
    branchesWritten.push(label);
  }

  return { rowsAN, rowsQX, branchesWritten };
}

// Builds one row per branch + Overall for EAF GM & EBITDA Entry (A:D only —
// E is a blank spacer, F is the fixed Branch Options list).
function buildGmEbitdaRows(targetDate, gmByBranch, existingKeys) {
  const dateSerial = dateToSerial(targetDate);
  const rows = [];
  const branchesWritten = [];

  for (const sheetTab of DATA_ENTRY_ROW_ORDER) {
    const label = dataEntryLabelFor(sheetTab);
    if (existingKeys.has(`${dateSerial}|${label}`)) {
      log(`hocReportsEntry: EAF GM & EBITDA Entry already has a ${label} row for ${isoDate(targetDate)} — skipping.`);
      continue;
    }
    const gm = gmByBranch[sheetTab] || {};
    const mtdGm = gm.mtd === null || gm.mtd === undefined ? '' : gm.mtd;
    rows.push([isoDate(targetDate), label, mtdGm, '']); // D EBITDA % — no automated source.
    branchesWritten.push(label);
  }

  return { rows, branchesWritten };
}

async function appendDataEntryRows(sheets, targetDate, metricsByBranch, gmByBranch) {
  const { spreadsheetId, dataEntryTab } = config.hocReports;
  const knownLabels = DATA_ENTRY_ROW_ORDER.map(dataEntryLabelFor);
  const { lastDataRow, existingKeys } = await scanExistingRows(sheets, spreadsheetId, dataEntryTab, knownLabels);

  const { rowsAN, rowsQX, branchesWritten } = buildDataEntryRows(targetDate, metricsByBranch, gmByBranch, existingKeys);
  if (branchesWritten.length === 0) {
    log(`hocReportsEntry: EAF Data Entry already up to date for ${isoDate(targetDate)} — nothing to insert.`);
    return { branchesWritten };
  }

  const sheetId = await getSheetId(sheets, spreadsheetId, dataEntryTab);
  const insertAt = lastDataRow; // 0-indexed startIndex == 1-indexed row right after the last data row
  await insertRowsAfter(sheets, spreadsheetId, sheetId, insertAt, rowsAN.length);

  const startRow = lastDataRow + 1;
  const endRow = lastDataRow + rowsAN.length;
  // Fill in real row numbers for Dodoma's formula placeholders now that we
  // know where the inserted rows actually landed.
  rowsAN.forEach((row, idx) => {
    const r = startRow + idx;
    for (let c = 0; c < row.length; c++) {
      if (typeof row[c] === 'string' && row[c].includes('{r}')) {
        row[c] = row[c].replace(/\{r\}/g, String(r));
      }
    }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${dataEntryTab}'!A${startRow}:N${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rowsAN },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${dataEntryTab}'!Q${startRow}:X${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rowsQX },
  });
  await applyColumnFormats(sheets, spreadsheetId, sheetId, startRow, endRow, EAF_DATA_ENTRY_FORMATS);

  log(`hocReportsEntry: EAF Data Entry — inserted ${rowsAN.length} row(s) for ${isoDate(targetDate)}: ${branchesWritten.join(', ')}.`);
  return { branchesWritten };
}

async function appendGmEbitdaRows(sheets, targetDate, gmByBranch) {
  const { spreadsheetId, gmEbitdaEntryTab } = config.hocReports;
  const knownLabels = DATA_ENTRY_ROW_ORDER.map(dataEntryLabelFor);
  const { lastDataRow, existingKeys } = await scanExistingRows(sheets, spreadsheetId, gmEbitdaEntryTab, knownLabels);

  const { rows, branchesWritten } = buildGmEbitdaRows(targetDate, gmByBranch, existingKeys);
  if (branchesWritten.length === 0) {
    log(`hocReportsEntry: EAF GM & EBITDA Entry already up to date for ${isoDate(targetDate)} — nothing to insert.`);
    return { branchesWritten };
  }

  const sheetId = await getSheetId(sheets, spreadsheetId, gmEbitdaEntryTab);
  const insertAt = lastDataRow;
  await insertRowsAfter(sheets, spreadsheetId, sheetId, insertAt, rows.length);

  const startRow = lastDataRow + 1;
  const endRow = lastDataRow + rows.length;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${gmEbitdaEntryTab}'!A${startRow}:D${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  await applyColumnFormats(sheets, spreadsheetId, sheetId, startRow, endRow, EAF_GM_EBITDA_FORMATS);

  log(`hocReportsEntry: EAF GM & EBITDA Entry — inserted ${rows.length} row(s) for ${isoDate(targetDate)}: ${branchesWritten.join(', ')}.`);
  return { branchesWritten };
}

// Writes yesterday's data into both HOC-REPORTS-final tabs, reusing the same
// metrics/GM already computed for DAILY_SNAPSHOT. Best-effort per tab: a
// failure on one tab is logged and surfaced to the caller, not thrown,
// so it can't take down the DAILY_SNAPSHOT write that already succeeded.
//
// withRetryOnce retries the WHOLE append (scan + insert + fill), not just the
// call that failed. Accepted trade-off: if a failure lands specifically
// between insertRowsAfter succeeding and the values.update fill that follows
// it, the retry's fresh scan won't recognize those still-blank inserted rows
// as data (col A isn't a date serial yet) and inserts a second blank block
// before filling it in — leaving one stray empty row behind. insertRowsAfter
// itself is a single Sheets batchUpdate call and can't "partially" apply, so
// the only possible outcome here is an extra blank row, never a wrong value
// or an overwrite — a cosmetic gap, not the data-loss class of bug this
// session's other fix (correctGmValues/collectCellUpdate) addressed.
async function runHocReportsEntry(sheets, targetDate, metricsByBranch, gmByBranch) {
  const results = { dataEntry: null, gmEbitdaEntry: null, errors: [] };
  try {
    results.dataEntry = await withRetryOnce('hocReportsEntry: EAF Data Entry write', () =>
      appendDataEntryRows(sheets, targetDate, metricsByBranch, gmByBranch)
    );
  } catch (err) {
    log(`hocReportsEntry: EAF Data Entry write failed: ${err.message}`);
    results.errors.push(`EAF Data Entry: ${err.message}`);
  }
  try {
    results.gmEbitdaEntry = await withRetryOnce('hocReportsEntry: EAF GM & EBITDA Entry write', () =>
      appendGmEbitdaRows(sheets, targetDate, gmByBranch)
    );
  } catch (err) {
    log(`hocReportsEntry: EAF GM & EBITDA Entry write failed: ${err.message}`);
    results.errors.push(`EAF GM & EBITDA Entry: ${err.message}`);
  }
  return results;
}

// Overwrites just the GM% cell of each already-existing row for targetDate
// (EAF Data Entry!D — daily; EAF GM & EBITDA Entry!C — MTD) with fresh
// values — used by the 05:30 verification run when its re-scrape disagrees
// with what the 05:00 run wrote (§4.1's dashboard-finalization race). Rows
// that don't exist yet are left alone here; the caller pairs this with
// runHocReportsEntry (insert-if-missing) to also cover the case where the
// 05:00 run never wrote anything at all (e.g. it failed outright).
// NOTE: a re-scrape's GM figure can legitimately come back null/unparseable
// (the same scrape flakiness alertOnGaps/missingGm already surfaces) — that
// must NEVER be written as a blank cell here, since this overwrites a row the
// 05:00 run (or a human) already filled in correctly. Doing so would silently
// destroy good data on top of the scrape failure it's alerting about. Each
// cell goes through collectCellUpdate (manualEntryRows.js), which skips (and
// logs) a null/undefined value instead of queuing it — the same guard
// ealReportsEntry.js's correction paths use, after a null-wipe incident on
// that side; applied here too since this function has the identical shape.
async function correctGmValues(sheets, targetDate, gmByBranch) {
  const { spreadsheetId, dataEntryTab, gmEbitdaEntryTab } = config.hocReports;
  const dateSerial = dateToSerial(targetDate);
  const knownLabels = DATA_ENTRY_ROW_ORDER.map(dataEntryLabelFor);
  const corrected = { dataEntry: [], gmEbitdaEntry: [] };
  // Collected across both tabs and sent as one values.batchUpdate call below
  // instead of one values.update per cell — up to 10 individual API round
  // trips (5 branches/OVERALL x 2 tabs) collapse into 1.
  const data = [];

  const dataEntryScan = await scanExistingRows(sheets, spreadsheetId, dataEntryTab, knownLabels);
  for (const sheetTab of DATA_ENTRY_ROW_ORDER) {
    const label = dataEntryLabelFor(sheetTab);
    const row = dataEntryScan.rowsByKey.get(`${dateSerial}|${label}`);
    if (!row) continue;
    const gm = gmByBranch[sheetTab] || {};
    const description = `${label} daily GM % for ${isoDate(targetDate)}`;
    if (collectCellUpdate(data, `'${dataEntryTab}'!D${row}`, gm.daily, description)) {
      corrected.dataEntry.push(label);
    }
  }

  const gmEbitdaScan = await scanExistingRows(sheets, spreadsheetId, gmEbitdaEntryTab, knownLabels);
  for (const sheetTab of DATA_ENTRY_ROW_ORDER) {
    const label = dataEntryLabelFor(sheetTab);
    const row = gmEbitdaScan.rowsByKey.get(`${dateSerial}|${label}`);
    if (!row) continue;
    const gm = gmByBranch[sheetTab] || {};
    const description = `${label} MTD GM % for ${isoDate(targetDate)}`;
    if (collectCellUpdate(data, `'${gmEbitdaEntryTab}'!C${row}`, gm.mtd, description)) {
      corrected.gmEbitdaEntry.push(label);
    }
  }

  await withRetryOnce('hocReportsEntry: GM% correction write', () => applyBatchUpdate(sheets, spreadsheetId, data));

  log(
    `hocReportsEntry: corrected GM% for existing rows — EAF Data Entry: ${corrected.dataEntry.join(', ') || 'none'}; EAF GM & EBITDA Entry: ${corrected.gmEbitdaEntry.join(', ') || 'none'}.`
  );
  return corrected;
}

module.exports = { runHocReportsEntry, correctGmValues };
