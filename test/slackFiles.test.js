const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// config.js reads process.env at require-time; set these before the first
// require of ../config (indirectly, via ../slackFiles) so dotenv (which
// doesn't override already-set vars) leaves them alone regardless of what's
// in .env.
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
process.env.SLACK_CHANNEL_ID = 'C12345';

const { uploadImageToSlack } = require('../slackFiles');
const config = require('../config');

function withMockedFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return fn().finally(() => {
    global.fetch = original;
  });
}

function makeTempPng() {
  const p = path.join(os.tmpdir(), `slack-test-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // minimal fake PNG bytes
  return p;
}

test('uploadImageToSlack calls getUploadURLExternal, uploads bytes, then completeUploadExternal, in order', async () => {
  const calls = [];
  const filePath = makeTempPng();
  try {
    await withMockedFetch(
      async (url, opts) => {
        calls.push({ url: String(url), opts });
        if (String(url).includes('files.getUploadURLExternal')) {
          return { json: async () => ({ ok: true, upload_url: 'https://upload.example/x', file_id: 'F123' }) };
        }
        if (String(url).includes('upload.example')) {
          return { ok: true };
        }
        if (String(url).includes('files.completeUploadExternal')) {
          return { json: async () => ({ ok: true }) };
        }
        throw new Error(`unexpected fetch to ${url}`);
      },
      () => uploadImageToSlack(filePath, { title: 'Test', comment: 'hello' })
    );

    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /files\.getUploadURLExternal/);
    assert.equal(calls[1].url, 'https://upload.example/x');
    assert.match(calls[2].url, /files\.completeUploadExternal/);

    // Regression test: files.getUploadURLExternal rejects a JSON body with
    // "invalid_arguments" (confirmed live 2026-08-15) — it must be sent as
    // form-urlencoded, unlike every other call in this file.
    assert.ok(calls[0].opts.body instanceof URLSearchParams);
    assert.equal(calls[0].opts.body.get('filename'), path.basename(filePath));
    assert.equal(calls[0].opts.body.get('length'), '4');

    const completeBody = JSON.parse(calls[2].opts.body);
    assert.equal(completeBody.channel_id, 'C12345');
    assert.deepEqual(completeBody.files, [{ id: 'F123', title: 'Test' }]);
    assert.equal(completeBody.initial_comment, 'hello');
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('uploadImageToSlack surfaces a Slack API error (ok:false) with the error code', async () => {
  const filePath = makeTempPng();
  try {
    await assert.rejects(
      withMockedFetch(
        async () => ({ json: async () => ({ ok: false, error: 'invalid_auth' }) }),
        () => uploadImageToSlack(filePath)
      ),
      /invalid_auth/
    );
  } finally {
    fs.unlinkSync(filePath);
  }
});

test('uploadImageToSlack throws clearly when SLACK_BOT_TOKEN is missing', async () => {
  const filePath = makeTempPng();
  const saved = config.slack.botToken;
  config.slack.botToken = undefined;
  try {
    await assert.rejects(uploadImageToSlack(filePath), /SLACK_BOT_TOKEN/);
  } finally {
    config.slack.botToken = saved;
    fs.unlinkSync(filePath);
  }
});

test('uploadImageToSlack throws clearly when SLACK_CHANNEL_ID is missing', async () => {
  const filePath = makeTempPng();
  const saved = config.slack.channelId;
  config.slack.channelId = undefined;
  try {
    await assert.rejects(uploadImageToSlack(filePath), /SLACK_CHANNEL_ID/);
  } finally {
    config.slack.channelId = saved;
    fs.unlinkSync(filePath);
  }
});
