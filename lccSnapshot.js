const { writeLccBlock } = require('./sheetsClient');
const { isoDate } = require('./dateUtils');

// Each channel table is a fixed 7 rows: title, blank, header, 3 channels +
// Overall — one header row then plain data rows underneath, same shape as
// DAILY_SNAPSHOT (title/control row, blank, one header, data rows), not a
// stack of differently-shaped mini-tables.
const CHANNEL_TABLE_ROWS = 7;
const YESTERDAY_BLOCK_ROWS = CHANNEL_TABLE_ROWS + 1 + CHANNEL_TABLE_ROWS; // Date table, blank separator, MTD table
const TODAY_BLOCK_ROWS = CHANNEL_TABLE_ROWS;
const YESTERDAY_START_ROW = 1;
const TODAY_START_ROW = YESTERDAY_START_ROW + YESTERDAY_BLOCK_ROWS + 1; // one blank separator row between blocks

function dash(value) {
  return value === null || value === undefined ? '-' : value;
}

// Channel rows never carry EBITDA — the LCC dashboard has no per-channel
// EBITDA anywhere (confirmed 2026-08-14: the channel drilldown only exposes
// a "Blended GM%", nothing else) — only the Overall row does, sourced from
// the company-wide topline KPI card rather than any per-channel figure.
function buildChannelTable(title, dateLabel, data) {
  return [
    [title, dateLabel],
    [],
    ['Channel', 'Value (TZS)', 'Blended GM %', 'EBITDA %'],
    ['External Transport', dash(data.channel.externalTransport.value), dash(data.channel.externalTransport.blendedGm), '-'],
    ['Transit', dash(data.channel.transit.value), dash(data.channel.transit.blendedGm), '-'],
    ['Other', dash(data.channel.other.value), dash(data.channel.other.blendedGm), '-'],
    ['Overall', dash(data.revenue.actual), dash(data.grossMargin.actual), dash(data.ebitda.actual)],
  ];
}

function buildYesterdayBlockGrid(targetDate, dateData, mtdData) {
  const dateLabel = isoDate(targetDate);
  return [
    ...buildChannelTable('LCC Transport P&L — Channel (Yesterday, final)', dateLabel, dateData),
    [],
    ...buildChannelTable('LCC Transport P&L — Channel (MTD)', dateLabel, mtdData),
  ];
}

function buildTodayBlockGrid(todayDate, dateData) {
  return buildChannelTable('LCC Transport P&L — Channel (Today, EOD snapshot 16:25)', isoDate(todayDate), dateData);
}

async function writeLccYesterdaySnapshot(sheets, targetDate, dateData, mtdData) {
  const grid = buildYesterdayBlockGrid(targetDate, dateData, mtdData);
  await writeLccBlock(sheets, YESTERDAY_START_ROW, grid);
}

async function writeLccTodaySnapshot(sheets, todayDate, dateData) {
  const grid = buildTodayBlockGrid(todayDate, dateData);
  await writeLccBlock(sheets, TODAY_START_ROW, grid);
}

module.exports = {
  buildYesterdayBlockGrid,
  buildTodayBlockGrid,
  writeLccYesterdaySnapshot,
  writeLccTodaySnapshot,
  YESTERDAY_BLOCK_ROWS,
  TODAY_BLOCK_ROWS,
  YESTERDAY_START_ROW,
  TODAY_START_ROW,
};
