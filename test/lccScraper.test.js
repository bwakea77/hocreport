const test = require('node:test');
const assert = require('node:assert/strict');
const { readKpiAndChannel } = require('../lccScraper');

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
  '↑5.0%',
  '40.0%',
  '500,000',
  'Transit',
  '↑5.0%',
  '30.0%',
  '300,000',
  'Other',
  '↑5.0%',
  '30.0%',
  '200,000',
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
    'External Transport\n↑5.0%\n40.0%\n500,000\n',
    'External Transport (NEW)\n↑5.0%\n40.0%\n500,000\n'
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
