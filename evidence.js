const fs = require('fs');
const path = require('path');
const { isoDate } = require('./dateUtils');
const { log } = require('./logger');

const EVIDENCE_DIR = path.join(__dirname, 'evidence');

// Unlike run.log (logger.js's size-based rotation), evidence accumulates one
// PNG per scrape indefinitely — three scheduled runs a day plus ad hoc
// backfills/retries adds up to unbounded disk growth with no cleanup path.
// 60 days comfortably covers the current MTD-lookback use case (proof of
// what the dashboard showed, for a given day's figures) plus a wide margin
// for late-noticed discrepancies, without keeping shots forever.
const MAX_EVIDENCE_AGE_MS = 60 * 24 * 60 * 60 * 1000;

// Best-effort: a cleanup failure (unreadable dir entry, permissions) is
// logged, not thrown — same reasoning as captureEvidence itself below,
// housekeeping must never take down the actual data pipeline.
function purgeOldEvidence() {
  let entries;
  try {
    entries = fs.readdirSync(EVIDENCE_DIR);
  } catch (err) {
    return; // dir doesn't exist yet — nothing to purge
  }
  const cutoff = Date.now() - MAX_EVIDENCE_AGE_MS;
  let purged = 0;
  for (const entry of entries) {
    const entryPath = path.join(EVIDENCE_DIR, entry);
    try {
      const stat = fs.statSync(entryPath);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(entryPath);
        purged++;
      }
    } catch (err) {
      log(`Evidence: failed to check/purge ${entryPath}: ${err.message}`);
    }
  }
  if (purged > 0) log(`Evidence: purged ${purged} screenshot(s) older than ${MAX_EVIDENCE_AGE_MS / 86400000} days.`);
}

// One full-page screenshot per run, named by target date + run label
// (e.g. evidence/2026-08-14_0500.png, evidence/2026-08-14_0530.png) — proof
// of what the EAF dashboard actually showed at scrape time, for whichever
// run's figures ended up in the sheets. Best-effort: a screenshot failure
// (disk full, page in a weird state) is logged, not thrown — losing the
// evidence shot must never take down the actual data pipeline.
async function captureEvidence(page, targetDate, runLabel) {
  const filePath = path.join(EVIDENCE_DIR, `${isoDate(targetDate)}_${runLabel}.png`);
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    purgeOldEvidence();
    await page.screenshot({ path: filePath, fullPage: true });
    log(`Evidence: saved screenshot to ${filePath}`);
    return filePath;
  } catch (err) {
    log(`Evidence: failed to save screenshot: ${err.message}`);
    return null;
  }
}

module.exports = { captureEvidence, EVIDENCE_DIR };
