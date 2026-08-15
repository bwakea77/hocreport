const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePercent } = require('../scraper');

test('parsePercent converts a percent string to a fraction', () => {
  assert.equal(parsePercent('24.7%'), 0.247);
  assert.equal(parsePercent('0%'), 0);
});

test('parsePercent treats dash/empty as no value', () => {
  assert.equal(parsePercent('—'), null);
  assert.equal(parsePercent('-'), null);
  assert.equal(parsePercent(''), null);
  assert.equal(parsePercent(null), null);
  assert.equal(parsePercent(undefined), null);
});

test('parsePercent rejects unparseable text', () => {
  assert.equal(parsePercent('n/a'), null);
});
