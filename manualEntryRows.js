// Generic helpers for appending/correcting rows in HOC-REPORTS-final's
// manual-entry tabs (EAF Data Entry, EAF GM & EBITDA Entry, EAL Data Entry —
// all share the same "date + label" row shape). Extracted out of
// hocReportsEntry.js so the EAL side (ealReportsEntry.js) can reuse the same
// scan/insert logic instead of re-implementing it.
const { log } = require('./logger');

async function getSheetId(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const found = (meta.data.sheets || []).find((s) => s.properties.title === title);
  if (!found) throw new Error(`manualEntryRows: tab "${title}" not found in spreadsheet ${spreadsheetId}`);
  return found.properties.sheetId;
}

// Scans column A/B of a manual-entry tab (from row 4 down) for existing data
// rows — a row counts as data iff col A is a numeric date serial AND col B is
// one of the known branch/segment labels. This naturally skips blank spacer
// rows and free-text instruction notes (like row 33 in EAF Data Entry),
// which have non-numeric/empty col A, without needing to special-case them.
async function scanExistingRows(sheets, spreadsheetId, tab, knownLabels) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    // Bounded generously (§ rawDataRange in config.js uses the same
    // approach) rather than tightly — at ~5 rows/day, a tight bound like the
    // 2000 this used to be fills up within about 13 months, after which rows
    // beyond it become invisible to lastDataRow/existingKeys: new rows would
    // insert at the wrong position and correction writes would silently stop
    // reaching old dates.
    range: `'${tab}'!A4:B20000`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = res.data.values || [];
  let lastDataRow = 3; // 1-indexed; row 3 is the header, so 3 means "no data rows yet"
  const rowsByKey = new Map(); // "dateSerial|Label" -> 1-indexed sheet row
  for (let i = 0; i < values.length; i++) {
    const [colA, colB] = values[i];
    const label = typeof colB === 'string' ? colB.trim() : '';
    if (typeof colA === 'number' && knownLabels.includes(label)) {
      const sheetRow = i + 4;
      lastDataRow = Math.max(lastDataRow, sheetRow);
      rowsByKey.set(`${colA}|${label}`, sheetRow);
    }
  }
  return { lastDataRow, rowsByKey, existingKeys: new Set(rowsByKey.keys()) };
}

// Inserts `count` blank rows immediately after `afterRow` (1-indexed),
// inheriting number formatting (date/percent/#,##0) from the row above so
// new rows render the same as the manually-entered ones instead of "General".
async function insertRowsAfter(sheets, spreadsheetId, sheetId, afterRow, count) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: afterRow, endIndex: afterRow + count },
            inheritFromBefore: true,
          },
        },
      ],
    },
  });
}

function blankRow(width) {
  return new Array(width).fill('');
}

// Explicitly (re)applies number formats to a range of newly-written rows.
// insertRowsAfter's inheritFromBefore only copies formatting from the row
// immediately above the insertion point — on a tab's very first-ever
// automated insert, that's the plain-text header row (no prior data row to
// inherit from), so relying on it alone silently leaves new rows in
// "General" format instead of the tab's intended date/percent formatting
// (confirmed 2026-08-14: EAL GM & EBITDA Entry's first insert landed as
// unformatted "46247"/"0.381" instead of "13/08/2026"/"38.1%"). Calling this
// after every insert makes formatting correct unconditionally, independent
// of whether the tab happened to already have a pre-formatted template row.
async function applyColumnFormats(sheets, spreadsheetId, sheetId, startRow, endRow, formats) {
  const requests = formats.map(({ startCol, endCol, numberFormat }) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: startRow - 1, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
      cell: { userEnteredFormat: { numberFormat } },
      fields: 'userEnteredFormat.numberFormat',
    },
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

// Adds `range`/`value` to `data` unless value is null/undefined, in which
// case the cell is left untouched (not blanked) and a warning is logged
// instead. Shared by every correction path (EAF GM, EAL Data Entry, EAL GM &
// EBITDA) so none of them can silently reintroduce the bug this fixed: a
// correction path that unconditionally writes "scraped value, or blank if
// null" silently overwrites a previously-good figure with blank on a scrape
// that only partially failed — confirmed happening in production (a Blended
// GM backfill wiped Revenue for two dates whose per-run channel regex missed
// while Blended GM parsed fine on the very same scrape) and, separately, in
// EAF Data Entry/EAF GM & EBITDA Entry (a 05:30 re-scrape that fails to parse
// GM for one branch used to blank that branch's already-correct 05:00 value
// instead of leaving it alone).
function collectCellUpdate(data, range, value, description) {
  if (value === null || value === undefined) {
    log(`manualEntryRows: ${description} unparseable on this scrape — leaving existing ${range} untouched.`);
    return false;
  }
  data.push({ range, values: [[value]] });
  return true;
}

async function applyBatchUpdate(sheets, spreadsheetId, data) {
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
}

module.exports = {
  getSheetId,
  scanExistingRows,
  insertRowsAfter,
  blankRow,
  applyColumnFormats,
  collectCellUpdate,
  applyBatchUpdate,
};
