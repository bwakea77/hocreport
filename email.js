const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('./config');
const { log } = require('./logger');

// Mirrors alert.js's queue/flush/pending-persistence shape exactly, over
// SMTP (Zoho Mail) instead of a Slack Incoming Webhook — every text alert
// this pipeline sends to Slack (gap/correction/failure/success) is also
// queued here so the same events reach ebwakea@eafoods.com by email.
let queued = [];

const PENDING_PATH = path.join(__dirname, 'pending-emails.json');
const MAX_PENDING_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_PENDING_ENTRIES = 50;

// Pure — kept separate from loadPendingEmails (which supplies `now` from
// Date.now()) so age-based dropping is testable with a fixed clock. Same
// logic as alert.js's filterFreshPending.
function filterFreshPending(entries, nowMs) {
  const cutoff = nowMs - MAX_PENDING_AGE_MS;
  return entries.filter((e) => e && typeof e.message === 'string' && Date.parse(e.queuedAt) >= cutoff);
}

function capPendingEntries(entries) {
  return entries.slice(-MAX_PENDING_ENTRIES);
}

function loadPendingEmails() {
  let raw;
  try {
    raw = fs.readFileSync(PENDING_PATH, 'utf8');
  } catch (err) {
    return [];
  }
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    log(`Email: pending-emails.json unreadable (${err.message}) — discarding it.`);
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const kept = filterFreshPending(entries, Date.now());
  const dropped = entries.length - kept.length;
  if (dropped > 0) {
    log(`Email: dropped ${dropped} pending email(s) older than ${MAX_PENDING_AGE_MS / 86400000} day(s) from a prior failed send.`);
  }
  return kept;
}

function savePendingEmails(entries) {
  const trimmed = capPendingEntries(entries);
  if (trimmed.length < entries.length) {
    log(`Email: pending queue exceeded ${MAX_PENDING_ENTRIES}, dropping ${entries.length - trimmed.length} oldest.`);
  }
  try {
    if (trimmed.length === 0) {
      if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
    } else {
      fs.writeFileSync(PENDING_PATH, JSON.stringify(trimmed, null, 2));
    }
  } catch (err) {
    log(`Email: failed to persist pending emails: ${err.message}`);
  }
}

function queueEmailAlert(message) {
  queued.push({ message, queuedAt: new Date().toISOString() });
}

// Mirrors alert.js's queueSuccessIfClean — only fires if nothing else was
// queued for email this run, so a clean run gets exactly one "completed
// successfully" email, same as it gets exactly one Slack message.
function queueEmailSuccessIfClean(message) {
  if (queued.length === 0) queueEmailAlert(message);
}

function isConfigured() {
  return Boolean(config.email.user && config.email.password && config.email.to);
}

// Lazily created and cached — one SMTP connection pool reused across every
// send in a run, rather than reconnecting per message.
let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: config.email.smtpHost,
    port: config.email.smtpPort,
    secure: config.email.smtpSecure,
    auth: { user: config.email.user, pass: config.email.password },
  });
  return cachedTransporter;
}

async function sendMail({ subject, text, attachmentPath }) {
  const transporter = getTransporter();
  const mailOptions = {
    from: config.email.from,
    to: config.email.to,
    subject,
    text,
  };
  if (attachmentPath) {
    mailOptions.attachments = [{ filename: path.basename(attachmentPath), path: attachmentPath }];
  }
  await transporter.sendMail(mailOptions);
}

// Sends every pending + newly queued alert by email, one message per entry —
// same call shape/timing as alert.js's flushAlerts (call once, near the end
// of a run, before the process exits), and the same "hold as pending, retry
// next run" behavior on failure or missing config.
async function flushEmailAlerts() {
  const pending = loadPendingEmails();
  const entries = [...pending, ...queued];
  queued = [];
  if (!entries.length) return;

  if (!isConfigured()) {
    log(`Email: EMAIL_USER/EMAIL_PASSWORD/EMAIL_TO not fully set, holding ${entries.length} message(s) for retry once configured.`);
    savePendingEmails(entries);
    return;
  }

  let sentCount = 0;
  try {
    for (const entry of entries) {
      await sendMail({ subject: entry.message.slice(0, 200), text: entry.message });
      sentCount++;
      log('Email alert sent.');
    }
  } catch (err) {
    const unsent = entries.slice(sentCount);
    log(`Email: ${unsent.length} message(s) unsent after failure (${err.message}) — persisting for retry on next run.`);
    savePendingEmails(unsent);
    throw err;
  }
}

// Emails a dashboard screenshot as an attachment — mirrors slackFiles.js's
// uploadImageToSlack (same {title, comment} shape), sent immediately rather
// than queued, since it's already called from inside its own best-effort
// try/catch (captureAndPostDashboardImages in index.js).
async function sendDashboardImageEmail(filePath, { title, comment } = {}) {
  if (!isConfigured()) {
    throw new Error('Email not configured — EMAIL_USER/EMAIL_PASSWORD/EMAIL_TO missing (see README).');
  }
  await sendMail({ subject: title || path.basename(filePath), text: comment || '', attachmentPath: filePath });
  log(`Email: sent ${path.basename(filePath)} to ${config.email.to}.`);
}

// Test-only: mirrors alert.js's test hooks.
function _resetForTest() {
  queued = [];
}

function _peekQueuedForTest() {
  return queued.slice();
}

// Test-only: injects a fake transporter ({ sendMail: async (opts) => {} })
// so flushEmailAlerts/sendDashboardImageEmail can be tested without a real
// SMTP connection — same idea as sheetImage.js's mockable execFile lookup.
function _setTransporterForTest(transporter) {
  cachedTransporter = transporter;
}

function _resetTransporterForTest() {
  cachedTransporter = null;
}

module.exports = {
  queueEmailAlert,
  queueEmailSuccessIfClean,
  flushEmailAlerts,
  sendDashboardImageEmail,
  filterFreshPending,
  capPendingEntries,
  _resetForTest,
  _peekQueuedForTest,
  _setTransporterForTest,
  _resetTransporterForTest,
};
