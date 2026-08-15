const config = require('./config');
const { log } = require('./logger');
const { isoDate, dateToSerial } = require('./dateUtils');
const { parsePercent } = require('./scraper');
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

// Column-index number formats for each tab's newly-inserted rows — applied
// explicitly after every insert rather than relying solely on
// insertRowsAfter's inheritFromBefore (see applyColumnFormats for why).
const EAL_DATA_ENTRY_FORMATS = [
  { startCol: 0, endCol: 1, numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } }, // A Date
  { startCol: 2, endCol: 3, numberFormat: { type: 'NUMBER', pattern: '#,##0' } }, // C Revenue
  { startCol: 4, endCol: 6, numberFormat: { type: 'PERCENT', pattern: '0.0%' } }, // E/F GM %, EBITDA %
];
const EAL_GM_EBITDA_FORMATS = [
  { startCol: 0, endCol: 1, numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } }, // A Date
  { startCol: 2, endCol: 4, numberFormat: { type: 'PERCENT', pattern: '0.0%' } }, // C/D GM %, EBITDA %
];

// EAL Data Entry (Transport P&L manual-entry log, see config.js) — one row
// per segment per day, mirroring EAF Data Entry's "date + label" shape but
// with LCC's own segments/columns (A..H; I is a blank spacer, J is the fixed
// "Segment Options" dropdown source list, left untouched).
const SEGMENT_LABELS = ['Transit', 'External', 'Other Income', 'Overall'];

// Segment rows (Transit/External/Other Income) get Revenue (C) from the LCC
// scrape's per-channel value, plus (as of 2026-08-15) their own single-day
// Blended GM % (E) from the same per-channel drilldown that already feeds
// EAL GM & EBITDA Entry's MTD version — Amount Collected (D), Available
// Trucks (G), and Booked (H) still have no equivalent on the dashboard and
// stay blank for manual entry.
function segmentRevenue(data) {
  return {
    Transit: data.channel.transit.value,
    External: data.channel.externalTransport.value,
    'Other Income': data.channel.other.value,
  };
}

// Per-segment Blended GM % (channel.<key>.blendedGm) plus Overall's
// company-wide GM % (grossMargin.actual) — same extraction whether `data` is
// a single day's scrape (daily, for EAL Data Entry) or a month-to-date range
// (for EAL GM & EBITDA Entry), since both share the same shape. Converted to
// a fraction with scraper.js's parsePercent since these cells are
// pre-formatted as PERCENT, expecting a raw fraction (0.123) rather than a
// "12.3%" string, the same convention EAF Data Entry's GM % column uses.
function segmentBlendedGm(data) {
  return {
    Transit: parsePercent(data.channel.transit.blendedGm),
    External: parsePercent(data.channel.externalTransport.blendedGm),
    'Other Income': parsePercent(data.channel.other.blendedGm),
    Overall: parsePercent(data.grossMargin.actual),
  };
}

// The Overall row's Revenue (C) is intentionally left blank — confirmed live
// against the sheet (2026-08-14): EAL-MORN/EAL-EOD's "YESTERDAY'S REVENUE"/
// "TODAY'S REVENUE" tables compute Overall's revenue by summing the 3
// segment rows themselves (SUM of per-segment SUMIFS), never reading an
// Overall row's own Revenue cell — so writing anything into it would just be
// dead data, per EAL Data Entry's own header note ("Revenue is summed
// automatically from the 3 segments on the EAL dashboard"). Overall's
// EBITDA % (F) comes off the company-wide KPI card — segments have no
// per-channel EBITDA on the dashboard, so F stays blank for them.
function buildEalDataEntryRows(targetDate, data, existingKeys) {
  const dateSerial = dateToSerial(targetDate);
  const rows = [];
  const segmentsWritten = [];

  const revenueBySegment = segmentRevenue(data);
  const gmBySegment = segmentBlendedGm(data);
  for (const label of ['Transit', 'External', 'Other Income']) {
    if (existingKeys.has(`${dateSerial}|${label}`)) {
      log(`ealReportsEntry: EAL Data Entry already has a ${label} row for ${isoDate(targetDate)} — skipping.`);
      continue;
    }
    const revenue = revenueBySegment[label];
    const gm = gmBySegment[label];
    const row = blankRow(8); // A..H
    row[0] = isoDate(targetDate); // A Date
    row[1] = label; // B Segment
    row[2] = revenue === null || revenue === undefined ? '' : revenue; // C Revenue
    row[4] = gm === null || gm === undefined ? '' : gm; // E Blended GM % (daily)
    rows.push(row);
    segmentsWritten.push(label);
  }

  if (existingKeys.has(`${dateSerial}|Overall`)) {
    log(`ealReportsEntry: EAL Data Entry already has an Overall row for ${isoDate(targetDate)} — skipping.`);
  } else {
    const gm = gmBySegment.Overall;
    const ebitda = parsePercent(data.ebitda.actual);
    const row = blankRow(8);
    row[0] = isoDate(targetDate);
    row[1] = 'Overall';
    row[4] = gm === null ? '' : gm; // E GM %
    row[5] = ebitda === null ? '' : ebitda; // F EBITDA %
    rows.push(row);
    segmentsWritten.push('Overall');
  }

  return { rows, segmentsWritten };
}

async function appendEalDataEntryRows(sheets, targetDate, data) {
  const { spreadsheetId, ealDataEntryTab } = config.hocReports;
  const { lastDataRow, existingKeys } = await scanExistingRows(sheets, spreadsheetId, ealDataEntryTab, SEGMENT_LABELS);

  const { rows, segmentsWritten } = buildEalDataEntryRows(targetDate, data, existingKeys);
  if (segmentsWritten.length === 0) {
    log(`ealReportsEntry: EAL Data Entry already up to date for ${isoDate(targetDate)} — nothing to insert.`);
    return { segmentsWritten };
  }

  const sheetId = await getSheetId(sheets, spreadsheetId, ealDataEntryTab);
  const insertAt = lastDataRow; // 0-indexed startIndex == 1-indexed row right after the last data row
  await insertRowsAfter(sheets, spreadsheetId, sheetId, insertAt, rows.length);

  const startRow = lastDataRow + 1;
  const endRow = lastDataRow + rows.length;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${ealDataEntryTab}'!A${startRow}:H${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  await applyColumnFormats(sheets, spreadsheetId, sheetId, startRow, endRow, EAL_DATA_ENTRY_FORMATS);

  log(`ealReportsEntry: EAL Data Entry — inserted ${rows.length} row(s) for ${isoDate(targetDate)}: ${segmentsWritten.join(', ')}.`);
  return { segmentsWritten };
}

// EAL GM & EBITDA Entry (config.js) — MTD counterpart to EAL Data Entry,
// mirroring EAF GM & EBITDA Entry's role on the EAF side: EAL-MORN/EAL-EOD's
// MTD GM%/EBITDA% tables read a real scraped MTD figure from here instead of
// treating EAL Data Entry's daily Overall row as a stand-in for MTD (those
// are not the same number). One row per segment per day (A..D; E is a blank
// spacer, F is the fixed "Segment Options" dropdown source list).
//
// Segments (Transit/External/Other Income) get MTD GM % (C) from the LCC
// dashboard's per-channel "Blended GM" drilldown (channel.<key>.blendedGm,
// already scraped for the MTD period same as for Yesterday) — EBITDA % (D)
// stays blank for them since no per-channel EBITDA exists on the dashboard
// (same constraint lccSnapshot.js documents for LCC_SNAPSHOT's channel
// tables). Overall gets both MTD GM % and MTD EBITDA % straight off the
// company-wide KPI cards. Extraction itself is segmentBlendedGm (shared with
// EAL Data Entry's daily version above) — only the input data's date range
// differs.
function buildEalGmEbitdaRows(targetDate, mtdData, existingKeys) {
  const dateSerial = dateToSerial(targetDate);
  const rows = [];
  const segmentsWritten = [];
  const gmBySegment = segmentBlendedGm(mtdData);
  const overallEbitda = parsePercent(mtdData.ebitda.actual);

  for (const label of SEGMENT_LABELS) {
    if (existingKeys.has(`${dateSerial}|${label}`)) {
      log(`ealReportsEntry: EAL GM & EBITDA Entry already has a ${label} row for ${isoDate(targetDate)} — skipping.`);
      continue;
    }
    const gm = gmBySegment[label];
    const ebitda = label === 'Overall' ? overallEbitda : null;
    rows.push([
      isoDate(targetDate),
      label,
      gm === null ? '' : gm,
      ebitda === null ? '' : ebitda,
    ]);
    segmentsWritten.push(label);
  }

  return { rows, segmentsWritten };
}

async function appendEalGmEbitdaRows(sheets, targetDate, mtdData) {
  const { spreadsheetId, ealGmEbitdaEntryTab } = config.hocReports;
  const { lastDataRow, existingKeys } = await scanExistingRows(sheets, spreadsheetId, ealGmEbitdaEntryTab, SEGMENT_LABELS);

  const { rows, segmentsWritten } = buildEalGmEbitdaRows(targetDate, mtdData, existingKeys);
  if (segmentsWritten.length === 0) {
    log(`ealReportsEntry: EAL GM & EBITDA Entry already up to date for ${isoDate(targetDate)} — nothing to insert.`);
    return { segmentsWritten };
  }

  const sheetId = await getSheetId(sheets, spreadsheetId, ealGmEbitdaEntryTab);
  const insertAt = lastDataRow;
  await insertRowsAfter(sheets, spreadsheetId, sheetId, insertAt, rows.length);

  const startRow = lastDataRow + 1;
  const endRow = lastDataRow + rows.length;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${ealGmEbitdaEntryTab}'!A${startRow}:D${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  await applyColumnFormats(sheets, spreadsheetId, sheetId, startRow, endRow, EAL_GM_EBITDA_FORMATS);

  log(`ealReportsEntry: EAL GM & EBITDA Entry — inserted ${rows.length} row(s) for ${isoDate(targetDate)}: ${segmentsWritten.join(', ')}.`);
  return { segmentsWritten };
}

// Writes yesterday's LCC figures into both EAL tabs (Data Entry + GM &
// EBITDA Entry), mirroring runHocReportsEntry's best-effort behavior:
// a failure on one tab is logged and surfaced to the caller, not thrown, so
// it can't take down the LCC_SNAPSHOT write that already succeeded, or the
// other tab's write. Same retry-of-the-whole-append trade-off as
// runHocReportsEntry (hocReportsEntry.js) — see the comment there.
async function runEalReportsEntry(sheets, targetDate, dateData, mtdData) {
  const result = { dataEntry: null, gmEbitdaEntry: null, errors: [] };
  try {
    result.dataEntry = await withRetryOnce('ealReportsEntry: EAL Data Entry write', () =>
      appendEalDataEntryRows(sheets, targetDate, dateData)
    );
  } catch (err) {
    log(`ealReportsEntry: EAL Data Entry write failed: ${err.message}`);
    result.errors.push(`EAL Data Entry: ${err.message}`);
  }
  try {
    result.gmEbitdaEntry = await withRetryOnce('ealReportsEntry: EAL GM & EBITDA Entry write', () =>
      appendEalGmEbitdaRows(sheets, targetDate, mtdData)
    );
  } catch (err) {
    log(`ealReportsEntry: EAL GM & EBITDA Entry write failed: ${err.message}`);
    result.errors.push(`EAL GM & EBITDA Entry: ${err.message}`);
  }
  return result;
}

// Overwrites EAL Data Entry's values for each already-existing row for
// targetDate — used by the 05:30 verification run when its re-scrape
// disagrees with what the 05:00 run wrote (same same-day finalization race
// §4.1 describes for EAF's GM). Rows that don't exist yet are left alone
// here; the caller pairs this with runEalReportsEntry (insert-if-missing) to
// also cover the case where the 05:00 run never wrote anything at all (e.g.
// it failed outright). Split out from EAL GM & EBITDA Entry's correction
// (correctEalGmEbitdaValues) so a caller that only has a fresh daily
// (dateData) scrape — e.g. a backfill re-deriving just the daily Blended
// GM% — never has to also touch (or fake) an MTD figure for the other tab.
async function correctEalDataEntryValues(sheets, targetDate, dateData) {
  const { spreadsheetId, ealDataEntryTab } = config.hocReports;
  const dateSerial = dateToSerial(targetDate);
  const corrected = [];
  const data = [];

  const dataEntryScan = await scanExistingRows(sheets, spreadsheetId, ealDataEntryTab, SEGMENT_LABELS);
  const revenueBySegment = segmentRevenue(dateData);
  const dailyGmBySegment = segmentBlendedGm(dateData);
  for (const label of ['Transit', 'External', 'Other Income']) {
    const row = dataEntryScan.rowsByKey.get(`${dateSerial}|${label}`);
    if (!row) continue;
    collectCellUpdate(data, `'${ealDataEntryTab}'!C${row}`, revenueBySegment[label], `${label} revenue for ${isoDate(targetDate)}`);
    // Separate single-cell update (not a combined C:E range) — D (Amount
    // Collected) sits between C and E and has no automated source, so it may
    // hold a real manual entry that a combined-range write would silently
    // blank out.
    collectCellUpdate(data, `'${ealDataEntryTab}'!E${row}`, dailyGmBySegment[label], `${label} Blended GM % for ${isoDate(targetDate)}`);
    corrected.push(label);
  }
  const overallDataEntryRow = dataEntryScan.rowsByKey.get(`${dateSerial}|Overall`);
  if (overallDataEntryRow) {
    const ebitda = parsePercent(dateData.ebitda.actual);
    collectCellUpdate(data, `'${ealDataEntryTab}'!E${overallDataEntryRow}`, dailyGmBySegment.Overall, `Overall GM % for ${isoDate(targetDate)}`);
    collectCellUpdate(data, `'${ealDataEntryTab}'!F${overallDataEntryRow}`, ebitda, `Overall EBITDA % for ${isoDate(targetDate)}`);
    corrected.push('Overall');
  }

  await withRetryOnce('ealReportsEntry: EAL Data Entry correction write', () => applyBatchUpdate(sheets, spreadsheetId, data));

  log(`ealReportsEntry: corrected EAL Data Entry for existing rows — ${corrected.join(', ') || 'none'}.`);
  return corrected;
}

// Overwrites EAL GM & EBITDA Entry's values for each already-existing row
// for targetDate — mirrors correctEalDataEntryValues above but for the MTD
// tab, from an mtdData (month-to-date range) scrape.
async function correctEalGmEbitdaValues(sheets, targetDate, mtdData) {
  const { spreadsheetId, ealGmEbitdaEntryTab } = config.hocReports;
  const dateSerial = dateToSerial(targetDate);
  const corrected = [];
  const data = [];

  const gmEbitdaScan = await scanExistingRows(sheets, spreadsheetId, ealGmEbitdaEntryTab, SEGMENT_LABELS);
  const gmBySegment = segmentBlendedGm(mtdData);
  const overallMtdEbitda = parsePercent(mtdData.ebitda.actual);
  for (const label of SEGMENT_LABELS) {
    const row = gmEbitdaScan.rowsByKey.get(`${dateSerial}|${label}`);
    if (!row) continue;
    collectCellUpdate(data, `'${ealGmEbitdaEntryTab}'!C${row}`, gmBySegment[label], `${label} MTD GM % for ${isoDate(targetDate)}`);
    if (label === 'Overall') {
      collectCellUpdate(data, `'${ealGmEbitdaEntryTab}'!D${row}`, overallMtdEbitda, `Overall MTD EBITDA % for ${isoDate(targetDate)}`);
    }
    corrected.push(label);
  }

  await withRetryOnce('ealReportsEntry: EAL GM & EBITDA Entry correction write', () => applyBatchUpdate(sheets, spreadsheetId, data));

  log(`ealReportsEntry: corrected EAL GM & EBITDA Entry for existing rows — ${corrected.join(', ') || 'none'}.`);
  return corrected;
}

// Corrects both EAL tabs together — used by the daily 05:30 verification run
// (see index.js), which always has both a fresh dateData and mtdData scrape
// on hand.
async function correctEalValues(sheets, targetDate, dateData, mtdData) {
  const dataEntry = await correctEalDataEntryValues(sheets, targetDate, dateData);
  const gmEbitdaEntry = await correctEalGmEbitdaValues(sheets, targetDate, mtdData);
  return { dataEntry, gmEbitdaEntry };
}

module.exports = {
  runEalReportsEntry,
  correctEalValues,
  correctEalDataEntryValues,
  correctEalGmEbitdaValues,
  appendEalDataEntryRows,
};
