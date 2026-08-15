// Shared date helpers used across the pipeline (scraping, sheet writes,
// snapshot stores, evidence capture) — kept independent of any single
// module's business logic since none of these depend on it.

function isoDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${yyyy}-${mm}-${dd}`;
}

// Date-only serial number (days since the Sheets epoch), matching how Sheets
// stores dates under UNFORMATTED_VALUE — computed from calendar Y/M/D only,
// so it's insensitive to time-of-day/timezone on the Date object passed in.
const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
function dateToSerial(date) {
  const dayUtcMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((dayUtcMs - SHEETS_EPOCH_UTC_MS) / 86400000);
}

// East Africa Time, UTC+3, no DST — the pipeline's target-date calendar day
// must be computed in EAT regardless of the host server's own timezone,
// since cron's host is never guaranteed to be set to EAT.
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

// Returns the calendar date `daysAgo` days before "today" in EAT, as a Date
// object holding that calendar day at LOCAL midnight (server tz) —
// deliberately not UTC midnight. Every reader of dates in this codebase
// (isoDate/dateToSerial above, dateToIso in metrics.js) reads the calendar
// day back out via LOCAL getters (getFullYear/getMonth/getDate), so the
// EAT-derived day round-trips correctly no matter what timezone the server
// itself runs in. Do NOT call getUTCFullYear/getUTCMonth/getUTCDate or
// toISOString on the result — those read back the wrong day whenever the
// server isn't itself running in UTC.
function eatCalendarDate(daysAgo = 0) {
  const eatNow = new Date(Date.now() + EAT_OFFSET_MS);
  return new Date(eatNow.getUTCFullYear(), eatNow.getUTCMonth(), eatNow.getUTCDate() - daysAgo);
}

module.exports = { isoDate, dateToSerial, eatCalendarDate };
