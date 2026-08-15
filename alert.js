const fs = require('fs');
const path = require('path');
const config = require('./config');
const { log } = require('./logger');

// A degraded run can generate several distinct alerts (a gap warning, a
// GM/LCC correction note, a failure message, or — when none of those fired —
// a single "run completed successfully" line, see queueSuccessIfClean below)
// — queued during the run and flushed together at the end, one Slack message
// per entry, over a single Incoming Webhook.
let queued = [];

// If a Slack send fails partway through flushAlerts (webhook revoked, network
// blip, Slack outage), the unsent messages used to just be gone — logged once
// and never retried, on the one subsystem whose entire job is telling a human
// something went wrong. Unsent messages are persisted here and re-attempted
// by the next run's flushAlerts, prepended ahead of whatever that run queues
// fresh.
const PENDING_PATH = path.join(__dirname, 'pending-alerts.json');
// Bounds how long a stuck alert keeps retrying and how many can pile up if
// Slack is down for an extended stretch — without these, a prolonged outage
// would mean pending-alerts.json grows forever and every future run spends
// longer re-sending an ever-larger backlog of decreasingly relevant messages.
const MAX_PENDING_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_PENDING_ENTRIES = 50;

// Pure — kept separate from loadPendingAlerts (which supplies `now` from
// Date.now()) so age-based dropping is testable with a fixed clock.
function filterFreshPending(entries, nowMs) {
  const cutoff = nowMs - MAX_PENDING_AGE_MS;
  return entries.filter((e) => e && typeof e.message === 'string' && Date.parse(e.queuedAt) >= cutoff);
}

// Pure — caps how many pending alerts can accumulate.
function capPendingEntries(entries) {
  return entries.slice(-MAX_PENDING_ENTRIES);
}

function loadPendingAlerts() {
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
    log(`Alert: pending-alerts.json unreadable (${err.message}) — discarding it.`);
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const kept = filterFreshPending(entries, Date.now());
  const dropped = entries.length - kept.length;
  if (dropped > 0) {
    log(`Alert: dropped ${dropped} pending alert(s) older than ${MAX_PENDING_AGE_MS / 86400000} day(s) from a prior failed send.`);
  }
  return kept;
}

function savePendingAlerts(entries) {
  const trimmed = capPendingEntries(entries);
  if (trimmed.length < entries.length) {
    log(`Alert: pending queue exceeded ${MAX_PENDING_ENTRIES}, dropping ${entries.length - trimmed.length} oldest.`);
  }
  try {
    if (trimmed.length === 0) {
      if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
    } else {
      fs.writeFileSync(PENDING_PATH, JSON.stringify(trimmed, null, 2));
    }
  } catch (err) {
    log(`Alert: failed to persist pending alerts: ${err.message}`);
  }
}

function queueAlert(message) {
  queued.push({ message, queuedAt: new Date().toISOString() });
  log(`Alert: queued — ${message}`);
}

// Queues `message` only if nothing else was queued so far this run — used at
// the very end of a run so every run posts exactly one Slack message no
// matter what: a gap/correction/failure message if something happened,
// otherwise this one green "completed successfully" line. Without this, a
// clean run stayed completely silent in Slack and the only way to confirm it
// ran at all was to check run.log.
function queueSuccessIfClean(message) {
  if (queued.length === 0) queueAlert(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Slack's Incoming Webhooks docs ask for roughly one message per second under
// sustained use — this pipeline only ever sends a handful per run, so this is
// a light defensive pause between sequential posts, not a real rate limiter.
const POST_INTERVAL_MS = 300;
// Guards against a hung request (Slack outage, network blip) holding the
// process — and therefore run.lock — open indefinitely.
const POST_TIMEOUT_MS = 15000;

async function postToSlack(message) {
  const res = await fetch(config.slack.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack webhook responded ${res.status}: ${body.slice(0, 300)}`);
  }
}

// Sends every pending + newly queued alert to Slack, one message per entry,
// over the configured Incoming Webhook. Call once, near the end of a run,
// before the process exits. Always checks pending-alerts.json regardless of
// whether this run queued anything new — a quiet, otherwise-uneventful run is
// still a chance to retry a previous run's stuck alert.
async function flushAlerts() {
  const pending = loadPendingAlerts();
  const entries = [...pending, ...queued];
  queued = [];
  if (!entries.length) return;

  if (!config.slack.webhookUrl) {
    log(`Alert: SLACK_WEBHOOK_URL not set, holding ${entries.length} message(s) for retry once it is set. Message(s) were: ${entries.map((e) => e.message).join(' | ')}`);
    savePendingAlerts(entries);
    return;
  }

  let sentCount = 0;
  try {
    for (const entry of entries) {
      await postToSlack(entry.message);
      sentCount++;
      log('Alert sent to Slack.');
      if (sentCount < entries.length) await sleep(POST_INTERVAL_MS);
    }
  } catch (err) {
    const unsent = entries.slice(sentCount);
    log(`Alert: ${unsent.length} message(s) unsent after failure (${err.message}) — persisting for retry on next run.`);
    savePendingAlerts(unsent);
    throw err;
  }
}

// Test-only: clears in-memory queue state between unit tests (module state
// otherwise persists across test() blocks within the same file/process).
function _resetForTest() {
  queued = [];
}

// Test-only: read-only peek at the in-memory queue.
function _peekQueuedForTest() {
  return queued.slice();
}

module.exports = {
  queueAlert,
  queueSuccessIfClean,
  flushAlerts,
  filterFreshPending,
  capPendingEntries,
  _resetForTest,
  _peekQueuedForTest,
};
