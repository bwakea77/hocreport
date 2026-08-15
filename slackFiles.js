const fs = require('fs');
const path = require('path');
const config = require('./config');
const { log } = require('./logger');

const SLACK_API = 'https://slack.com/api';
const REQUEST_TIMEOUT_MS = 30000;

async function slackApiPost(method, body) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Slack's API convention: HTTP 200 even for API-level errors, with an
  // `ok:false` + `error` code in the JSON body — checked here instead of
  // res.ok/res.status.
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error || res.status}`);
  }
  return data;
}

// files.getUploadURLExternal specifically rejects a JSON body with
// "invalid_arguments" (confirmed 2026-08-15 against the live API) — Slack's
// own docs show this endpoint's params sent as simple form fields, unlike
// most other Web API methods (including files.completeUploadExternal right
// below, which does take JSON). URLSearchParams as the body also gets fetch
// to set the form-urlencoded Content-Type automatically, same as how
// FormData below gets its multipart Content-Type set automatically.
async function slackApiPostForm(method, params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    body.append(key, String(value));
  }
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.slack.botToken}` },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error || res.status}`);
  }
  return data;
}

// Uploads a local image file to Slack and shares it into
// config.slack.channelId, via the current (files.getUploadURLExternal +
// files.completeUploadExternal) two-step flow — the older single-call
// files.upload method Slack deprecated in favor of this one. Requires a Bot
// Token with the files:write scope (the Incoming Webhook already configured
// for text alerts can't upload files at all — a Slack platform limitation,
// not a config choice) and the bot user to be a member of the target channel
// (invite it once: /invite @<bot name> in that channel).
async function uploadImageToSlack(filePath, { title, comment } = {}) {
  if (!config.slack.botToken) {
    throw new Error('SLACK_BOT_TOKEN not set — cannot upload images to Slack (see README).');
  }
  if (!config.slack.channelId) {
    throw new Error('SLACK_CHANNEL_ID not set — cannot upload images to Slack (see README).');
  }

  const filename = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  const urlResp = await slackApiPostForm('files.getUploadURLExternal', {
    filename,
    length: fileBuffer.length,
  });

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: 'image/png' }), filename);
  const uploadRes = await fetch(urlResp.upload_url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!uploadRes.ok) {
    throw new Error(`Slack file upload failed: ${uploadRes.status}`);
  }

  await slackApiPost('files.completeUploadExternal', {
    files: [{ id: urlResp.file_id, title: title || filename }],
    channel_id: config.slack.channelId,
    initial_comment: comment,
  });

  log(`Alert: uploaded ${filename} to Slack channel ${config.slack.channelId}.`);
}

module.exports = { uploadImageToSlack };
