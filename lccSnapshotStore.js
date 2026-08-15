const fs = require('fs');
const path = require('path');
const { isoDate } = require('./dateUtils');

const SNAPSHOT_PATH = path.join(__dirname, 'lcc-snapshot.json');

// Persists the 05:00 run's scraped LCC figures (Yesterday + MTD channel
// tables) so the 05:30 verification run can compare against them — mirrors
// gmSnapshotStore's rationale: the dashboard can still be settling shortly
// after midnight, so the same finalization race applies here, not just to
// EAF's GM. Keyed by target date, overwritten fresh by tomorrow's 05:00 run.
function saveLccSnapshot(targetDate, data) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({ date: isoDate(targetDate), data }, null, 2));
}

// Returns null (not just missing/stale data) if there's nothing to compare
// against — file doesn't exist, or it's for a different date (e.g. the
// 05:00 run never ran or failed before saving). The caller treats null as
// "no baseline" and writes the 05:30 data unconditionally.
function loadLccSnapshot(targetDate) {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
  if (parsed.date !== isoDate(targetDate)) return null;
  return parsed.data;
}

const NUMERIC_EPSILON = 0.5; // TZS — comfortably below rounding noise in the raw figures

function valuesDiffer(a, b) {
  if (a === null || a === undefined) return b !== null && b !== undefined;
  if (b === null || b === undefined) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > NUMERIC_EPSILON;
  return a !== b;
}

const CHANNEL_FIELDS = [
  ['revenue', (d) => d.revenue.actual],
  ['gross margin', (d) => d.grossMargin.actual],
  ['ebitda', (d) => d.ebitda.actual],
  ['external transport value', (d) => d.channel.externalTransport.value],
  ['external transport blended GM', (d) => d.channel.externalTransport.blendedGm],
  ['transit value', (d) => d.channel.transit.value],
  ['transit blended GM', (d) => d.channel.transit.blendedGm],
  ['other value', (d) => d.channel.other.value],
  ['other blended GM', (d) => d.channel.other.blendedGm],
];

function fmt(v) {
  return v === null || v === undefined ? '-' : v;
}

function compareChannelTable(label, previous, current, diffs) {
  for (const [name, getter] of CHANNEL_FIELDS) {
    const prevVal = getter(previous);
    const currVal = getter(current);
    if (valuesDiffer(prevVal, currVal)) {
      diffs.push(`${label} ${name}: ${fmt(prevVal)} → ${fmt(currVal)}`);
    }
  }
}

// Compares the scraped LCC figures (Yesterday + MTD channel tables) between
// two runs. previous/current are both { dateData, mtdData } shapes as
// produced by scraping 'Yesterday' and 'MTD'. Returns a list of
// human-readable diffs; empty means "stable, nothing to correct."
function compareLcc(previous, current) {
  const diffs = [];
  compareChannelTable('Yesterday', previous.dateData, current.dateData, diffs);
  compareChannelTable('MTD', previous.mtdData, current.mtdData, diffs);
  return diffs;
}

module.exports = { saveLccSnapshot, loadLccSnapshot, compareLcc };
