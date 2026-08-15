const { google } = require('googleapis');
const config = require('./config');
const { log } = require('./logger');

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.sheets.serviceAccountKeyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function getBranchRawRows(sheets, branchSheetTab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${branchSheetTab}!${config.sheets.rawDataRange}`,
  });
  return res.data.values || [];
}

// Returns the tab's numeric sheetId (needed for batchUpdate requests like
// repeatCell, which address sheets by id, not title), creating the tab first
// if it doesn't exist yet.
async function ensureTabExists(sheets, tabName) {
  const { spreadsheetId } = config.sheets;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = (meta.data.sheets || []).find((s) => s.properties.title === tabName);
  if (existing) return existing.properties.sheetId;

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  log(`Sheets: created missing tab ${tabName}`);
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function ensureDailySnapshotTabExists(sheets) {
  await ensureTabExists(sheets, config.sheets.dailySnapshotTab);
}

// Full rewrite every run since the set of products sold varies day to day,
// so row positions can't be treated as stable (§5.1's original label-lookup
// approach doesn't apply once the whole tab is script-generated rather than
// formula-driven).
//
// Previously this wrote the new grid, then cleared leftover rows from a
// prior, larger run in a SEPARATE values.clear call — a crash between the
// two left the tab in a mixed state (this run's data, plus a prior run's
// stale trailing rows) until the next successful run happened to fix it.
// Reading the tab's current extent first and padding the grid with blank
// rows out to that extent means the whole rewrite — new data AND blanking
// anything a shorter/narrower run leaves behind — happens in the one
// values.update call below, so there's no window where a crash mid-run can
// leave old and new content mixed. Each row is also padded out to the
// grid's own full column width for the same reason: a short row (e.g. the
// 2-column "Date:" row, or the blank separator row) previously left
// whatever a wider row wrote at those same coordinates in some earlier run
// untouched, since values.update never clears columns a given row doesn't
// mention.
async function writeDailySnapshotGrid(sheets, grid) {
  const { spreadsheetId, dailySnapshotTab } = config.sheets;
  await ensureDailySnapshotTabExists(sheets);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${dailySnapshotTab}!A1:I100000`,
  });
  const previousRowCount = (existing.data.values || []).length;
  const totalRows = Math.max(grid.length, previousRowCount);
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);

  const padded = grid.map((row) => {
    const r = row.slice();
    while (r.length < width) r.push('');
    return r;
  });
  for (let i = grid.length; i < totalRows; i++) {
    padded.push(new Array(width).fill(''));
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${dailySnapshotTab}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: padded },
  });
  log(`Sheets: wrote ${dailySnapshotTab} (${grid.length} rows, blanked through row ${totalRows})`);
}

// Writes a fixed-size LCC_SNAPSHOT block (Yesterday or Today, see
// lccSnapshot.js) starting at a fixed row. The row COUNT is fixed (the LCC
// dashboard's categories — zones, channels — are a fixed set, not a
// variable-length product list), but row WIDTH varies by section (the KPI
// table is 3 columns, channel/zone tables are 4-5, blank separator rows are
// 0) — and `values.update` never clears a cell it isn't explicitly given a
// value for, so a blank row writes nothing at all. Confirmed 2026-08-14: a
// narrower/reshaped grid (e.g. after adding a column, or a blank row where a
// wider row used to be) left the previous run's stale values sitting in the
// now-unwritten cells.
//
// This used to be three separate calls: values.clear, a repeatCell
// batchUpdate resetting format, then values.update. The value-clear is now
// folded into the values.update below (every row padded out to the block's
// full 5-column width — a value.update with an empty string clears that
// cell same as values.clear would), cutting it to two calls instead of
// three and closing the window where a crash left this block's rows with
// stale old VALUES sitting in cells the write never touched. The format
// reset has to stay a separate call: a cell's NUMBER FORMAT is sticky
// across a later plain values.update even once the cell is blanked —
// confirmed 2026-08-14, a cell that held a percent-style value in an
// earlier, differently-shaped grid kept its percent format, so writing a
// later plain number (e.g. a target of 35184044) into that same coordinate
// rendered as "3518404400.00%". The remaining gap between these two calls
// leaves the block blank-but-correctly-formatted at worst if a crash lands
// there — the same brief-empty-window trade-off already accepted here (this
// block's rows only, payload small enough to be effectively instant), not
// the stale-mixed-format corruption this replaces.
async function writeLccBlock(sheets, startRow, grid) {
  const { spreadsheetId, lccSnapshotTab } = config.sheets;
  const sheetId = await ensureTabExists(sheets, lccSnapshotTab);
  const endRow = startRow + grid.length - 1;
  const width = 5; // A:E

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: startRow - 1, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: width },
            cell: { userEnteredFormat: {} },
            fields: 'userEnteredFormat',
          },
        },
      ],
    },
  });

  const padded = grid.map((row) => {
    const r = row.slice();
    while (r.length < width) r.push('');
    return r;
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${lccSnapshotTab}!A${startRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: padded },
  });
  log(`Sheets: wrote ${lccSnapshotTab} rows ${startRow}-${endRow}`);
}

module.exports = { getSheetsClient, getBranchRawRows, writeDailySnapshotGrid, writeLccBlock };
