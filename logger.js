const fs = require('fs');
const config = require('./config');

// run.log otherwise grows forever (fs.appendFileSync, no eviction) — rotate
// it before it gets large enough to be unwieldy to open/tail, keeping a
// bounded number of prior generations instead of one ever-growing file.
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 5;

// Generic same-directory rotation (rename .N -> .N+1, current -> .1) used for
// run.log below, and also exposed so index.js can apply the identical policy
// to cron.log — the crontab recipe in the README pipes cron's own stdout/
// stderr straight into cron.log with no bound of its own (unlike run.log,
// which this file already rotates), so left alone it grows forever for the
// life of the cron job.
function rotateFileIfNeeded(filePath, maxBytes = MAX_LOG_BYTES, maxGenerations = MAX_ROTATED_FILES) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    return; // file doesn't exist yet — nothing to rotate
  }
  if (size < maxBytes) return;

  for (let i = maxGenerations - 1; i >= 1; i--) {
    const src = `${filePath}.${i}`;
    if (fs.existsSync(src)) {
      fs.renameSync(src, `${filePath}.${i + 1}`);
    }
  }
  fs.renameSync(filePath, `${filePath}.1`);
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  rotateFileIfNeeded(config.logging.filePath);
  fs.appendFileSync(config.logging.filePath, line + '\n');
}

module.exports = { log, rotateFileIfNeeded };
