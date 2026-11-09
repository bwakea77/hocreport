const test = require('node:test');
const assert = require('node:assert/strict');
const { readKpiAndChannel, countTrucksWithRevenue } = require('../lccScraper');

const SAMPLE_BODY_LINES = [
  'REVENUE',
  '12.3%',
  '▲',
  'A:',
  'TZS 1,234,567',
  '',
  'GROSS MARGIN',
  '24.7%',
  '▲',
  'A:',
  '24.7%',
  '',
  'EBITDA',
  '10.1%',
  '▲',
  'A:',
  '10.1%',
  '',
  'External Transport',
  '500,000',
  '↑5.0%',
  'GM 40.0%',
  'Transit',
  '300,000',
  '↑5.0%',
  'GM 30.0%',
  'Other',
  '200,000',
  '↑5.0%',
];
const SAMPLE_BODY = SAMPLE_BODY_LINES.join('\n') + '\n';

test('readKpiAndChannel parses a well-formed page', () => {
  const result = readKpiAndChannel(SAMPLE_BODY);
  assert.equal(result.revenue.actual, 1234567);
  assert.equal(result.grossMargin.actual, '24.7%');
  assert.equal(result.ebitda.actual, '10.1%');
  assert.equal(result.channel.externalTransport.value, 500000);
  assert.equal(result.channel.transit.value, 300000);
  assert.equal(result.channel.other.value, 200000);
});

// Regression test for the bug where a single combined regex spanning all
// three channel rows meant a layout change to ONE channel nulled all three —
// see lccScraper.js's matchChannelValue comment.
test('a layout change affecting one channel only nulls that channel, not the others', () => {
  const broken = SAMPLE_BODY.replace(
    'External Transport\n500,000\n↑5.0%\nGM 40.0%\n',
    'External Transport (NEW)\n500,000\n↑5.0%\nGM 40.0%\n'
  );
  const result = readKpiAndChannel(broken);
  assert.equal(result.channel.externalTransport.value, null); // the affected row
  assert.equal(result.channel.transit.value, 300000); // unaffected rows still parse
  assert.equal(result.channel.other.value, 200000);
});

test('a missing KPI card only nulls that card, not the channel table', () => {
  const broken = SAMPLE_BODY.replace('REVENUE\n12.3%\n▲\nA:\nTZS 1,234,567\n', '');
  const result = readKpiAndChannel(broken);
  assert.equal(result.revenue.actual, null);
  assert.equal(result.channel.externalTransport.value, 500000);
});

// Real drilldown innerText sample captured live 2026-09-13 (Transit,
// 2026-09-12) — one truck with 0 revenue among four with real revenue.
const TRUCK_DRILLDOWN_SAMPLE =
  'TransitTZS 65,720,000\nGM%: 62.9%\n5 trucks active\n' +
  'TRUCK\tREVENUE\tREVENUE SHARE\tGM%\tTRIPS\n' +
  'T 560 EHU\t16,430,000\t\n25.0%\n\t71.1%\t1\n' +
  'T 620 ELM\t16,430,000\t\n25.0%\n\t71.1%\t1\n' +
  'T 466 EJP\t16,430,000\t\n25.0%\n\t70.2%\t1\n' +
  'T 901 EGY\t16,430,000\t\n25.0%\n\t70.4%\t1\n' +
  'T 621 EJU\t0\t\n0.0%\n\t0.0%\t1\n' +
  "Click any row to drill into that truck's trips\n-55%";

test('countTrucksWithRevenue counts only trucks with revenue > 0, out of the total active', () => {
  const result = countTrucksWithRevenue(TRUCK_DRILLDOWN_SAMPLE);
  assert.equal(result.withRevenue, 4);
  assert.equal(result.total, 5);
});

test('countTrucksWithRevenue returns 0/0 when no truck rows are present', () => {
  const result = countTrucksWithRevenue('External TransportTZS 0\nGM%: 0.0%\n0 trucks active\n');
  assert.equal(result.withRevenue, 0);
  assert.equal(result.total, 0);
});

// Layout live since 2026-10-31 (text captured from the dashboard 2026-11-09):
// "Actual" replaces "A:", and the revenue card is rounded ("TZS 15.7M"), so
// revenue must come from the exact Revenue by Channel total instead.
const REDESIGN_BODY = [
  'REVENUE', '34.8%', '▼', 'Actual', 'TZS 15.7M', 'Target', 'TZS 45.1M',
  'GROSS MARGIN', '29.3%', '▼', 'Actual', '29.3%', 'Target', '35.0%',
  'EBITDA', '-71.7%', '▼', 'Actual', '-71.7%', 'Target', '10.0%',
  'Revenue by Channel', '', 'Revenue breakdown by stream', '', 'TZS 15,712,271', 'vs prior period',
  'External Transport', '9,776,271', '↑0.0%', 'GM 27.0%',
  'Transit', '5,936,000', '↓81.6%', 'GM 33.3%',
  'Other', '0', '↑0.0%',
  'Revenue by Zone',
].join('\n');

test('readKpiAndChannel parses the 2026-10-31 redesign with exact (unrounded) revenue', () => {
  const r = readKpiAndChannel(REDESIGN_BODY);
  assert.equal(r.revenue.actual, 15712271);
  assert.equal(r.grossMargin.actual, '29.3%');
  assert.equal(r.ebitda.actual, '-71.7%');
  assert.equal(r.channel.externalTransport.value, 9776271);
  assert.equal(r.channel.transit.value, 5936000);
  assert.equal(r.channel.other.value, 0);
});
