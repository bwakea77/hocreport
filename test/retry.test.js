const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetryOnce } = require('../retry');

test('withRetryOnce returns the result on first success without retrying', async () => {
  let calls = 0;
  const result = await withRetryOnce('label', async () => {
    calls++;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetryOnce retries exactly once after a failure, then returns the retry result', async () => {
  let calls = 0;
  const result = await withRetryOnce('label', async () => {
    calls++;
    if (calls === 1) throw new Error('transient');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetryOnce propagates the error if the retry also fails', async () => {
  let calls = 0;
  await assert.rejects(
    withRetryOnce('label', async () => {
      calls++;
      throw new Error('still broken');
    }),
    /still broken/
  );
  assert.equal(calls, 2);
});
