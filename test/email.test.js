const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// config.js reads process.env at require-time; set these before the first
// require of ../config (indirectly, via ../email) so dotenv (which doesn't
// override already-set vars) leaves them alone regardless of what's in .env.
process.env.EMAIL_USER = 'bot@example.com';
process.env.EMAIL_PASSWORD = 'test-app-password';
process.env.EMAIL_TO = 'ebwakea@eafoods.com';

const {
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
} = require('../email');
const config = require('../config');

const PENDING_PATH = path.join(__dirname, '..', 'pending-emails.json');

function cleanupPending() {
  if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
}

function makeTempPng() {
  const p = path.join(os.tmpdir(), `email-test-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // minimal fake PNG bytes
  return p;
}

// Same pure-function behavior as alert.js's equivalents — email.js
// deliberately mirrors that shape for its own pending-emails.json queue.
test('filterFreshPending keeps entries within the age cutoff and drops older/malformed ones', () => {
  const now = Date.parse('2026-08-15T00:00:00.000Z');
  const entries = [
    { message: 'fresh', queuedAt: new Date(now - 1000).toISOString() },
    { message: 'too old', queuedAt: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString() },
    { queuedAt: new Date(now).toISOString() }, // no `message` string -> dropped regardless of age
  ];
  const kept = filterFreshPending(entries, now);
  assert.deepEqual(kept.map((e) => e.message), ['fresh']);
});

test('capPendingEntries keeps only the most recent MAX_PENDING_ENTRIES (50)', () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ message: `m${i}`, queuedAt: new Date().toISOString() }));
  const kept = capPendingEntries(entries);
  assert.equal(kept.length, 50);
  assert.equal(kept[0].message, 'm10');
  assert.equal(kept[kept.length - 1].message, 'm59');
});

test('queueEmailSuccessIfClean queues its message when nothing else was queued this run', () => {
  _resetForTest();
  queueEmailSuccessIfClean('✅ all good');
  assert.deepEqual(_peekQueuedForTest().map((e) => e.message), ['✅ all good']);
});

test('queueEmailSuccessIfClean stays silent if a warning/failure was already queued this run', () => {
  _resetForTest();
  queueEmailAlert('⚠️ something is off');
  queueEmailSuccessIfClean('✅ all good');
  assert.deepEqual(_peekQueuedForTest().map((e) => e.message), ['⚠️ something is off']);
});

test('flushEmailAlerts sends every queued message via the transporter, in order', async () => {
  _resetForTest();
  cleanupPending();
  const sent = [];
  _setTransporterForTest({
    sendMail: async (opts) => {
      sent.push(opts);
    },
  });
  try {
    queueEmailAlert('first');
    queueEmailAlert('second');
    await flushEmailAlerts();

    assert.equal(sent.length, 2);
    assert.equal(sent[0].to, 'ebwakea@eafoods.com');
    assert.equal(sent[0].text, 'first');
    assert.equal(sent[1].text, 'second');
    assert.equal(_peekQueuedForTest().length, 0);
    assert.equal(fs.existsSync(PENDING_PATH), false);
  } finally {
    _resetTransporterForTest();
    cleanupPending();
  }
});

test('flushEmailAlerts persists unsent messages for retry when the transporter fails partway through', async () => {
  _resetForTest();
  cleanupPending();
  let call = 0;
  _setTransporterForTest({
    sendMail: async () => {
      call++;
      if (call === 2) throw new Error('SMTP connection reset');
    },
  });
  try {
    queueEmailAlert('ok one');
    queueEmailAlert('fails here');
    queueEmailAlert('never sent');
    await assert.rejects(flushEmailAlerts(), /SMTP connection reset/);

    assert.ok(fs.existsSync(PENDING_PATH));
    const persisted = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
    assert.deepEqual(
      persisted.map((e) => e.message),
      ['fails here', 'never sent']
    );
  } finally {
    _resetTransporterForTest();
    cleanupPending();
  }
});

test('flushEmailAlerts holds messages as pending (no send attempt) when email is not configured', async () => {
  _resetForTest();
  cleanupPending();
  const saved = { ...config.email };
  config.email.password = undefined;
  let calledSend = false;
  _setTransporterForTest({ sendMail: async () => { calledSend = true; } });
  try {
    queueEmailAlert('should be held');
    await flushEmailAlerts();

    assert.equal(calledSend, false);
    assert.ok(fs.existsSync(PENDING_PATH));
    const persisted = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
    assert.deepEqual(persisted.map((e) => e.message), ['should be held']);
  } finally {
    Object.assign(config.email, saved);
    _resetTransporterForTest();
    cleanupPending();
  }
});

test('sendDashboardImageEmail sends the file as an attachment with the given title/comment', async () => {
  const filePath = makeTempPng();
  const sent = [];
  _setTransporterForTest({
    sendMail: async (opts) => {
      sent.push(opts);
    },
  });
  try {
    await sendDashboardImageEmail(filePath, { title: 'EAF (0500)', comment: 'daily EAF screenshot' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'EAF (0500)');
    assert.equal(sent[0].text, 'daily EAF screenshot');
    assert.equal(sent[0].attachments[0].filename, path.basename(filePath));
    assert.equal(sent[0].attachments[0].path, filePath);
  } finally {
    _resetTransporterForTest();
    fs.unlinkSync(filePath);
  }
});

test('sendDashboardImageEmail throws clearly when email is not configured', async () => {
  const filePath = makeTempPng();
  const saved = { ...config.email };
  config.email.to = undefined;
  try {
    await assert.rejects(sendDashboardImageEmail(filePath), /EMAIL_USER\/EMAIL_PASSWORD\/EMAIL_TO/);
  } finally {
    Object.assign(config.email, saved);
    fs.unlinkSync(filePath);
  }
});
