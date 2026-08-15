const { log } = require('./logger');

// Retries a Sheets write once on failure before giving up — most transient
// API hiccups (rate limit, brief network blip) succeed on the second try; a
// second failure is treated as real and propagates to the caller. Previously
// only DAILY_SNAPSHOT's write had this (inline in index.js); HOC-REPORTS-final
// and EAL writes had zero retries, so a transient hiccup there went straight
// to a "gaps" Slack alert requiring a human even though the same class of
// blip would have silently self-healed on the DAILY_SNAPSHOT path. Shared here
// so every Sheets write path gets the same one-retry treatment.
async function withRetryOnce(label, fn) {
  try {
    return await fn();
  } catch (err) {
    log(`${label} failed, retrying once: ${err.message}`);
    return await fn();
  }
}

module.exports = { withRetryOnce };
