const test = require('node:test');
const assert = require('node:assert/strict');
const { isoDate, dateToSerial } = require('../dateUtils');

test('isoDate formats a local Date as YYYY-MM-DD', () => {
  assert.equal(isoDate(new Date(2026, 7, 5)), '2026-08-05'); // August 5 2026 (0-indexed month)
});

test('dateToSerial matches Sheets/Excel-style serials (Dec 30 1899 epoch)', () => {
  assert.equal(dateToSerial(new Date(1899, 11, 30)), 0);
  assert.equal(dateToSerial(new Date(1899, 11, 31)), 1);
  assert.equal(dateToSerial(new Date(2026, 0, 1)), 46023);
});

test('dateToSerial is independent of time-of-day', () => {
  const withTime = new Date(2026, 7, 12, 23, 59, 59);
  const midnight = new Date(2026, 7, 12, 0, 0, 0);
  assert.equal(dateToSerial(withTime), dateToSerial(midnight));
});
