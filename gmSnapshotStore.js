const fs = require('fs');
const path = require('path');
const { isoDate } = require('./dateUtils');

const SNAPSHOT_PATH = path.join(__dirname, 'gm-snapshot.json');

// Persists the 05:00 run's scraped GM figures so the 05:30 verification run
// can compare against them once the dashboard has had more time to finalize
// (§4.1 of the build spec: "Today" isn't reliably finalized until ~5:00 AM).
// Keyed by target date, not run timestamp — only ever holds one day's data,
// overwritten fresh by tomorrow's 05:00 run.
function saveGmSnapshot(targetDate, gmByBranch) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({ date: isoDate(targetDate), gmByBranch }, null, 2));
}

// Returns null (not just missing/stale data) if there's nothing to compare
// against — either the file doesn't exist, or it's for a different date
// (e.g. the 05:00 run never ran or failed before saving). The caller treats
// null as "no baseline" and writes the 05:30 data unconditionally rather
// than silently skipping.
function loadGmSnapshot(targetDate) {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
  if (data.date !== isoDate(targetDate)) return null;
  return data.gmByBranch;
}

const KEYS = ['BUNJU', 'KINYEREZI', 'DODOMA', 'ONJA', 'OVERALL'];
const EPSILON = 0.0005; // 0.05 percentage points — comfortably below display rounding (0.1%)

function numbersDiffer(a, b) {
  if (a === null || a === undefined) return b !== null && b !== undefined;
  if (b === null || b === undefined) return true;
  return Math.abs(a - b) > EPSILON;
}

// Compares only the scraped GM% figures (daily + MTD per branch, plus
// Overall) between two gmByBranch snapshots — the one piece of this
// pipeline with a known same-day finalization race. Revenue/ASP/etc. come
// from Google Sheets raw data, which has no equivalent quirk, so they're
// out of scope for this check. Returns a list of human-readable diffs;
// empty means "stable, nothing to correct."
function compareGm(previous, current) {
  const diffs = [];
  for (const key of KEYS) {
    const prev = previous[key] || {};
    const curr = current[key] || {};
    for (const field of ['daily', 'mtd']) {
      if (numbersDiffer(prev[field], curr[field])) {
        const fmt = (v) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`);
        diffs.push(`${key} ${field}: ${fmt(prev[field])} → ${fmt(curr[field])}`);
      }
    }
  }
  return diffs;
}

module.exports = { saveGmSnapshot, loadGmSnapshot, compareGm };
