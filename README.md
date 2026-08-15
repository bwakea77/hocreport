# HOC Sales Reporting Automation

Daily pipeline that regenerates the `DAILY_SNAPSHOT` tab of the master
Google Sheet from scratch every run: per-product revenue/loadout/returns/ASP/
discount for yesterday (computed from the 4 branch tabs), plus gross margin
(GM) daily/MTD scraped from the EAF Sales Command Center dashboard. See
`automation_build_spec.md` for the original design this was built from —
note that the spec assumed `_SUMMARY`/`DAILY_SNAPSHOT` tabs already existed
as live formulas; they didn't, so this computes everything in the script
instead and writes plain values (see "Notes" below).

The same run also appends yesterday's row(s) into two tabs of a second,
separate workbook — **HOC-REPORTS-final** — that the team fills in manually:
`EAF Data Entry` (per-branch revenue/GM/ASP/returns/discount/loadout, with a
Banana/Potato breakdown for Dodoma, plus an Overall row) and
`EAF GM & EBITDA Entry` (per-branch + Overall MTD GM%). See
`hocReportsEntry.js` for the exact column mapping and why EBITDA%/Dodoma's
per-product GM% (Q/U) are left blank for manual entry — neither has an
automated source.

A second, independent scrape target — the **EAL Dashboard**
(`lcc.eafoods.com`, Transport P&L) — writes its own `LCC_SNAPSHOT` tab in the
same master sheet: a "Yesterday" block refreshed by the two EAF runs below,
and a separate "Today" block refreshed by a third, 16:25 run. The two blocks
live at fixed row ranges and never touch each other. Each is one or two
simple Channel tables — title/date row, blank, one header row, then plain
data rows (External Transport/Transit/Other + an Overall row), same shape as
`DAILY_SNAPSHOT` — with columns Value (TZS), Blended GM% (read from the
truck-level breakdown you get by clicking into a channel), and EBITDA%
(blank for the three channels, filled only on the Overall row, since this
dashboard has no per-channel EBITDA anywhere). The Yesterday block has two
such tables — one for the specific date, one for MTD; the Today (EOD) block
has just the one. See `lccScraper.js`/`lccSnapshot.js` for details.

Runs twice a day: **05:00** (primary) and **05:30** (verification). Both
exist because of the dashboard's known finalization race (§4.1 of the
build spec) — "Today"'s figure for yesterday isn't reliably settled right
at 05:00, so 05:30 re-scrapes and compares. If nothing moved, it's a no-op;
if something did (or the 05:00 run never wrote anything at all), 05:30's
figures are treated as final and overwrite DAILY_SNAPSHOT and both
HOC-REPORTS-final GM columns, with a Slack alert describing exactly what
changed. Each run also saves a full-page screenshot of the dashboard to
`evidence/` as a record of what it actually saw.

## One-time setup

### 1. Install dependencies

```
npm install
npx playwright install --with-deps chromium
```

Also needs **poppler-utils** (`pdftocairo`) installed as a system package —
used by `sheetImage.js` to rasterize dashboard-image PDFs into PNGs (see §6
below). Chromium was tried for this first and rejected: it has no working
PDF viewer available in Playwright's bundled build, confirmed two different
ways (direct navigation triggers a download; wrapping it in an `<embed>`
renders "Couldn't load plugin"). `pdftocairo` is a dedicated PDF rasterizer
with no such problem, and like Playwright's own browser above, it's a
system-level install `npm install` alone doesn't provide:

```
apt-get install poppler-utils
```

### 2. Google service account (§1a of the spec) — already done

Project `hocreports`, service account `sheets-writer@hocreports.iam.gserviceaccount.com`,
Sheets API enabled, key saved to `service-account.json` (gitignored), and the
master spreadsheet has been shared with that service account as Editor.
Nothing to do here unless the key is ever rotated — in which case: GCP
Console → IAM & Admin → Service Accounts → `sheets-writer` → Keys → Add Key →
JSON, replace `service-account.json`.

### 3. `.env`

Already populated with the dashboard URL/credentials and both spreadsheet
IDs (`GOOGLE_SHEETS_SPREADSHEET_ID` for the master sheet,
`HOC_REPORTS_SPREADSHEET_ID` for HOC-REPORTS-final), plus `LCC_URL`/
`LCC_USERNAME`/`LCC_PASSWORD` for the EAL Dashboard (Transport P&L). Only
`SLACK_WEBHOOK_URL` still needs filling in — see step 5 below. The service
account already has Editor access to both spreadsheets — nothing to share
manually.

### 4. Capture the EAF dashboard session

```
node scripts/captureEafSession.js
```

Logs in once with the credentials in `.env` and saves the session to
`eaf-session.json`. The daily run reuses this file instead of logging in
every time. Re-run this command whenever the pipeline's alert says the
session has expired.

### 4b. Capture the LCC (EAL Dashboard) session

```
node scripts/captureLccSession.js
```

Same idea, separate site: logs into `lcc.eafoods.com` and saves the session
to `lcc-session.json`. Re-run whenever a run's alert says the LCC session
has expired.

### 5. Create the Slack Incoming Webhook

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
   Name it something like `HOC Reports Bot` and pick the workspace.
2. In the app's settings, open **Incoming Webhooks** (left sidebar) and
   toggle it **On**.
3. Click **Add New Webhook to Workspace**, pick the channel every alert
   should post to (e.g. `#hoc-reports-alerts`), and authorize it.
4. Copy the webhook URL Slack shows you (`https://hooks.slack.com/services/...`)
   into `.env` as `SLACK_WEBHOOK_URL`. Treat it like a password — anyone with
   this URL can post to that channel as the app, so it's gitignored the same
   as every other credential in this project.
5. Send a test message to confirm it works before relying on it:
   ```
   node -e "const a = require('./alert'); a.queueAlert('test'); a.flushAlerts().then(() => console.log('sent'))"
   ```
   You should see it land in the channel within a couple of seconds, and
   `sent` printed once it's confirmed delivered.

No browser/QR-linking step, no persistent session directory to protect — a
webhook POST is a single stateless HTTPS request, confirmed reachable from
this host (`curl -v https://hooks.slack.com/` completes a normal TLS
handshake). This pipeline previously used WhatsApp specifically because an
earlier attempt at Telegram's Bot API found this host's ISP silently blocking
outbound TLS to `api.telegram.org` past the initial TCP handshake (general
internet, Google Sheets, and the EAF dashboard were all unaffected) —
`hooks.slack.com` was checked against the same failure mode before this
migration and is not blocked.

### 6. Dashboard screenshots (optional, but on by default)

Every run also screenshots a few dashboard tabs (config.js's
`sheetImages.targets`) and posts them as images into the same Slack channel
as the text alert — **not** the raw tabs this pipeline writes
(`DAILY_SNAPSHOT`/`LCC_SNAPSHOT`/HOC-REPORTS-final's manual-entry tabs), but
human-built dashboard views on top of that data: `EAF`, `EAL-MORN`, and
`EAL-EOD`, which live in **HOC-REPORTS-final** (confirmed live 2026-08-15 —
they sit alongside `EAF Data Entry`/`EAL Data Entry`, not `DAILY_SNAPSHOT` in
the master sheet, despite the naming similarity), already referenced
elsewhere in this codebase, e.g. the `EAF` tab's `K22` lookup in
`hocReportsEntry.js`. This only needs one additional thing beyond steps 1-5
above: Slack Incoming Webhooks can't upload files at all, so posting an
actual image needs a Bot Token on the same Slack app. Screenshotting the
sheet itself needs **no separate credential** — `sheetImage.js` downloads
Google's per-range PDF export authenticated as the same sheets-writer
service account every other Sheets API call in this file already uses (it
already has Editor access to both spreadsheets from step 2), not a real
human Google login.

**Add a Bot Token to the same Slack app:**

1. Back in https://api.slack.com/apps → your app → **OAuth & Permissions**.
2. Under **Scopes → Bot Token Scopes**, add `files:write` and `chat:write`.
3. Click **Install to Workspace** (or **Reinstall** if it's already
   installed) to apply the new scopes.
4. Copy the **Bot User OAuth Token** (`xoxb-...`) into `.env` as
   `SLACK_BOT_TOKEN`.
5. In the target Slack channel, invite the bot so it's allowed to post there:
   `/invite @HOC Reports Bot` (or whatever you named it).
6. Get the channel's ID (Slack desktop/web: open the channel → **View
   channel details** → scroll down → **Channel ID**, or right-click the
   channel → **Copy link** and take the `C...` segment from the URL) and put
   it in `.env` as `SLACK_CHANNEL_ID` — normally the same channel the webhook
   posts text alerts to.

**Verify it end-to-end** — run any of the three manual commands below and
check Slack for both the text message and the image(s). If an image doesn't
show up, check `run.log` for "Dashboard image capture" — the alert (posted
via the text webhook, same as any other gap) distinguishes an access problem
(the service account isn't actually shared on that spreadsheet, or
`drive.readonly` wasn't granted — see `SheetExportAccessError` in
`sheetImage.js`) from anything else. This whole mechanism reuses an
undocumented Google endpoint, so the very first run is the real test of it —
see the Notes entry below for what's most likely to need adjusting.

Adjust or remove targets by editing `config.sheetImages.targets.morning`
(05:00/05:30) and `.eod` (16:25) — each entry is `{ tab, range }`, plus
`{ spreadsheetId }` for any tab not in the master sheet (all three current
targets set it, since `EAF`/`EAL-MORN`/`EAL-EOD` are in HOC-REPORTS-final).

## Running manually

```
npm start          # primary (05:00) run
node index.js --verify   # verification (05:30) run
node index.js --eod       # LCC-only EOD (16:25) run
```

Computes `target_date = today - 1 day`, scrapes GM (daily + month-to-date)
for all 4 branches, reads each branch's raw rows for that date, aggregates
per product (§2.4 grouping rules), and rewrites the whole `DAILY_SNAPSHOT`
tab (clear + rebuild — row positions shift daily since the product list
sold varies). Exits non-zero and sends a Slack alert on any failure — and, on
a clean run, a single green "completed successfully" message (see Notes
below). All runs are logged to `run.log`.

The `--verify` run re-scrapes GM and compares it against the primary run's
snapshot (`gm-snapshot.json`) — see "Notes" below for what happens on a
mismatch.

## Cron

Add to `crontab -e` (adjust the path):

```
0 5 * * * cd /path/to/this/project && /usr/bin/node index.js >> /path/to/this/project/cron.log 2>&1
30 5 * * * cd /path/to/this/project && /usr/bin/node index.js --verify >> /path/to/this/project/cron.log 2>&1
25 16 * * * cd /path/to/this/project && /usr/bin/node index.js --eod >> /path/to/this/project/cron.log 2>&1
```

05:00 is right at the point the dashboard is expected to finalize the prior
day's "Today" figure (§4.1 of the spec); 05:30 exists specifically to catch
the case where it hadn't actually settled yet by 05:00. 16:25 is the LCC-only
EOD read of "Today" on the EAL Dashboard, independent of the other two.

## Testing

```
npm test
```

Runs the `node:test` suite under `test/` — pure-function unit tests for the
logic the pipeline's correctness actually rests on: date/number parsing and
per-product aggregation (`metrics.js`), the LCC dashboard's KPI/channel
regexes (`lccScraper.js`), snapshot diffing (`gmSnapshotStore.js`/
`lccSnapshotStore.js`), the correction-write null guard
(`manualEntryRows.js`'s `collectCellUpdate`), the dashboard-image export URL
builder and PDF-response handling (`sheetImage.js`'s `buildRangeExportUrl`/
`fetchRangeExportPdf`, with `fetch` mocked), and the Slack file-upload call
sequence (`slackFiles.js`, also with `fetch` mocked). `sheetImage.js`'s
`renderPdfToPng` also gets a real (unmocked) integration test against the
actual `pdftocairo` binary and a hand-built minimal PDF fixture, since that's
exactly the step that silently produced broken images before this pipeline
switched away from Chromium — everything else here runs purely against
fixture data, no live Sheets/dashboard/Slack access needed. The parts that
still need a real end-to-end run to verify (the EAF/LCC login-capture
scripts, actually reaching Google/Slack over the network) aren't covered
here — see the README's setup steps for those.

## Files

| File | Purpose |
|---|---|
| `config.js` | Spreadsheet ID, branch mapping, dashboard selectors, raw column layout |
| `sheetsClient.js` | Service-account auth, raw row fetch, DAILY_SNAPSHOT tab create/clear/write |
| `metrics.js` | Parses raw branch rows (dates, accounting-negative numbers) and aggregates per product (§2.4 rules) |
| `dailySnapshot.js` | Builds the DAILY_SNAPSHOT grid (per-branch GM + product table + TOTAL) and writes it |
| `scraper.js` | Playwright: reads GM (Today + Month-to-Date) for all 4 branches, takes the evidence screenshot |
| `hocReportsEntry.js` | Appends/corrects yesterday's row(s) in HOC-REPORTS-final's `EAF Data Entry` and `EAF GM & EBITDA Entry` tabs |
| `ealReportsEntry.js` | Appends/corrects yesterday's row(s) in HOC-REPORTS-final's `EAL Data Entry` and `EAL GM & EBITDA Entry` tabs |
| `manualEntryRows.js` | Shared scan/insert/format helpers for the four manual-entry tabs above, incl. `collectCellUpdate` — the null-safe correction-write guard both correction paths use |
| `retry.js` | `withRetryOnce` — one automatic retry for a Sheets write, used consistently by every write/correction path in this pipeline |
| `sheetImage.js` | Screenshots a dashboard tab's cell range as a PNG, via Google Sheets' per-range PDF export (authenticated as the sheets-writer service account) + `pdftocairo` (poppler-utils) |
| `slackFiles.js` | Uploads a local image file to Slack (Bot Token, `files.getUploadURLExternal`/`files.completeUploadExternal`) — separate from `alert.js`'s webhook-based text alerts, since Incoming Webhooks can't upload files |
| `gmSnapshotStore.js` | Persists the 05:00 run's GM figures (`gm-snapshot.json`) and diffs them against the 05:30 re-scrape |
| `lccSnapshotStore.js` | Same idea as `gmSnapshotStore.js`, for the LCC dashboard's scraped figures (`lcc-snapshot.json`) |
| `evidence.js` | Saves each run's full-page dashboard screenshot to `evidence/` |
| `alert.js` | Slack (Incoming Webhook) success/gap/correction/failure notification |
| `index.js` | Orchestrator — run this (or cron it); `--verify` selects the 05:30 behavior, `--eod` selects the 16:25 LCC-only behavior |
| `logger.js` | Shared append-to-`run.log` + console logging, plus the size-based rotation policy also applied to `cron.log` |
| `scripts/captureEafSession.js` | One-time (or post-expiry) EAF dashboard login/session capture |
| `lccScraper.js` | Playwright: reads the EAL Dashboard's (lcc.eafoods.com) Revenue/GM/EBITDA, Revenue by Channel, and Revenue by Zone for a given PERIOD ("Yesterday" or "Today") |
| `lccSnapshot.js` | Builds and writes the two fixed-size `LCC_SNAPSHOT` blocks (Yesterday, Today) |
| `scripts/captureLccSession.js` | One-time (or post-expiry) LCC dashboard login/session capture |
| `test/` | `node --test` unit tests for the pure parsing/aggregation/comparison logic (date math, `metrics.js`'s row aggregation, the LCC KPI/channel regexes, snapshot diffing, the correction-write null guard) — run with `npm test` |

## Notes / known limits

- **The spec assumed `DAILY_SNAPSHOT` and the `_SUMMARY` tabs already existed
  as live SUMIFS/AVERAGEIFS formulas.** They didn't exist at all in the
  actual spreadsheet — only the 4 raw branch tabs did. So instead of writing
  two GM cells into a pre-built formula sheet, this pipeline computes
  everything in Node and fully regenerates `DAILY_SNAPSHOT` (clear + rewrite)
  every run. The `_SUMMARY` (all-time) tabs from §3.1 were not built — only
  the daily view the user asked for.
- Raw branch-tab dates are text like `12-Aug-2026`, not `DD/MM/YYYY` as the
  spec assumed; `metrics.js` parses that format specifically.
- Raw numbers include leading spaces, thousand-separator commas, and
  accounting-style negatives like `(20,000)`; `metrics.js` handles all three.
- ONJA is fully collapsed to a single "Rice" line for this daily view (no
  variant breakdown), per §2.4.
- The dashboard has no literal "month to date" filter option; `config.js`
  uses its "This Month" option (1st-of-month through today), which is the
  MTD equivalent as long as the dashboard computes it that way.
- Login form and table have no stable `id`/`name`/`data-testid` attributes
  (React app) — selectors in `config.js` are structural (input types, column
  position). If EAF redesigns the dashboard, re-run
  `scripts/captureEafSession.js` and inspect the page again; selectors are
  centralized there and don't require touching `scraper.js`.
- A branch's GM cell renders blank (not zeroed or guessed) if the scrape
  can't read it for that branch — check `run.log` for "missing/unparseable"
  entries.
- If a run completes but any of the following happened, `DAILY_SNAPSHOT` is
  still written (best-effort) but a separate "⚠️ ... written but with gaps"
  Slack alert fires — a "succeeded" run.log entry doesn't guarantee
  complete data, check for that alert too:
  - a branch's raw tab returned zero rows entirely
  - any GM figure came back missing/unparseable
  - every branch matched zero rows for the target date despite having
    historical data (a single quiet branch is normal and not flagged; all 4
    at once usually means the upstream raw data for that date hasn't landed
    yet)
  - a branch's raw tab header no longer lines up with `config.js`'s
    `rawColumns` mapping (previously only logged to `run.log`, easy to miss)
- The target date is computed from a fixed East-Africa-Time (UTC+3) offset,
  not the server's local clock — the cron host's own timezone no longer
  matters for correctness.
- `index.js` takes a PID lockfile (`run.lock`) for the duration of a run and
  refuses to start if another run is still active (stale locks from a dead
  pid are reclaimed automatically). If a run seems stuck, check whether
  `run.lock` is holding a live pid before assuming it's just slow.
- `hocReportsEntry.js` inserts new rows (not a rewrite) into a live sheet the
  team also edits by hand, so it's idempotent per branch/date: it scans
  existing rows first and skips any branch already present for the target
  date, rather than appending a duplicate. New rows are inserted right after
  the last existing data row (inheriting that row's number formatting), which
  pushes the sheets' own trailing instruction notes further down — expected,
  matches how the team has been growing these tabs by hand.
- Discount is stored with **opposite sign** between the two spreadsheets:
  negative in the master sheet's raw tabs/`DAILY_SNAPSHOT` (source
  convention), positive in HOC-REPORTS-final's `EAF Data Entry` (matches
  every existing manually-typed row there) — `hocReportsEntry.js` flips the
  sign when writing.
- Dodoma's per-product GM% (`EAF Data Entry` columns Q/U) is left blank: the
  EAF dashboard only exposes GM at the branch level, never broken down by
  product, so there's no automated source for it. The sheet's own note says
  the combined GM% (D) should eventually become a formula from Q/U once
  those are filled in by hand; until then, D is written as the branch-level
  scraped GM, same as every historical Dodoma row.
- `EAF GM & EBITDA Entry` gets the scraped **MTD** GM% (not daily) — its own
  note describes it as updated periodically (e.g. monthly close) rather than
  a daily live read, and MTD is the closer match. EBITDA% has no automated
  source anywhere and is always left blank for manual entry.
- `EAF Data Entry` also gets a 5th row per day, `Overall`, with only column D
  (daily GM %) filled — added because the `EAF` tab's "Branch Yesterday's
  Performance" table (cell `K22`) does an exact-date lookup for the Overall
  branch's GM%, and it used to point at `EAF GM & EBITDA Entry` (which only
  ever holds MTD for Overall) — a silent MTD-shown-as-daily mismatch. `K22`
  was repointed to `EAF Data Entry` to match how the 4 real branches' GM%
  already work in that same table. `Overall`'s revenue/ASP/etc. are left
  blank in `EAF Data Entry` since the `EAF` tab already derives those via
  `SUM()` of the 4 branch rows.
- The **05:30 verification run** only compares the scraped GM% figures
  (daily + MTD, per branch + Overall) against the 05:00 run's snapshot —
  revenue/ASP/returns/discount/loadout come from Google Sheets raw data,
  which has no equivalent same-day finalization race, so they're out of
  scope for the check. On a mismatch (or a missing/failed 05:00 baseline),
  05:30 rewrites `DAILY_SNAPSHOT` in full and overwrites just the GM% cell
  of each already-existing HOC-REPORTS-final row (`EAF Data Entry!D`,
  `EAF GM & EBITDA Entry!C`) via `hocReportsEntry.js`'s `correctGmValues` —
  it never touches revenue/ASP/etc. in those rows. A Slack alert lists
  exactly which branch/field changed and by how much. If nothing moved,
  05:30 is a pure no-op — no rewrite, no alert (beyond the usual
  "completed successfully" message every run posts, see below).
- **Every correction path (`correctGmValues`, `correctEalDataEntryValues`,
  `correctEalGmEbitdaValues`) writes a cell only when the re-scrape actually
  produced a value.** A branch/segment whose figure comes back
  null/unparseable on the 05:30 re-scrape is skipped — the existing cell (from
  the 05:00 run, or a human) is left untouched, not blanked, and it's logged
  instead (`manualEntryRows.js`'s `collectCellUpdate`, shared by all three
  correction paths). This matters because `compareGm`/`compareLcc` treat "had
  a value, now null" as a diff worth correcting — without this guard, a
  transient scrape hiccup at 05:30 for even one branch would silently
  overwrite that branch's already-correct HOC-REPORTS-final cell with a blank,
  on top of the scrape failure `missingGm`/`findLccGaps` is already alerting
  about. The gap is still surfaced via that alert either way; this just stops
  it from destroying good data too.
- **Every Sheets write/correction path gets one automatic retry on failure**
  (`retry.js`'s `withRetryOnce`) — previously only `DAILY_SNAPSHOT`'s write
  did (inline in `index.js`); a transient API hiccup on any HOC-REPORTS-final
  or EAL write used to go straight to a "gaps" Slack alert with no retry.
- **Every run posts exactly one message to Slack, even when there's nothing
  to report.** `queueAlert` (`alert.js`) is used for every gap/correction/
  failure message as before; `queueSuccessIfClean`, called once at the very
  end of `index.js`'s `run()`, posts a single green "✅ ... Run completed
  successfully" line — but only if nothing else was already queued that run.
  Before this, a fully clean run stayed completely silent in Slack, and the
  only way to confirm the 05:00/05:30/16:25 cron jobs actually ran (as
  opposed to, say, the cron daemon itself being down, or the host being off)
  was to check `run.log` by hand.
- **Alerting moved from WhatsApp (`whatsapp-web.js`) to a Slack Incoming
  Webhook** — a single stateless HTTPS POST (`fetch`, no new dependency)
  instead of a full headless-Chromium WhatsApp Web session. `pending-alerts.json`
  (retry-unsent-alerts-next-run) and the queue/flush shape are unchanged;
  only the transport (`postToSlack` in `alert.js`) is new. If you're migrating
  an existing deployment: delete `.wwebjs_auth/`/`.wwebjs_cache/` (no longer
  used) and go to WhatsApp → Linked Devices on the phone that used to send
  alerts to remove the old linked session there too — deleting the local
  session files does not unlink it server-side.
- `gm-snapshot.json` holds only the most recent target date's GM figures —
  tomorrow's 05:00 run overwrites it fresh. If both the 05:00 run and this
  file are somehow missing when 05:30 runs, it treats that as "no baseline"
  and writes its own scrape as primary rather than silently doing nothing.
- Each run (05:00 and 05:30) saves one full-page screenshot of the
  dashboard's daily "Branches Performance" view to `evidence/`, named
  `<target-date>_<0500|0530>.png` — a record of what the site actually
  showed for whichever run's figures ended up in the sheets. Best-effort:
  a screenshot failure is logged, never treated as a pipeline failure.
- **Dashboard-image posting** (`sheetImage.js`/`slackFiles.js`, wired into
  `index.js`'s `captureAndPostDashboardImages`) runs at the very end of each
  of the three runs, after every other write for that run has already
  succeeded — same best-effort posture as the evidence screenshot above: one
  target's screenshot/upload failing is logged and surfaced as its own Slack
  text warning (via the existing webhook), never thrown, and never blocks
  another target in the same run or fails the run itself.
  - `sheet-images/` (gitignored) accumulates one PNG per target per run,
    same as `evidence/` before that got a 60-day purge — no purge is wired up
    for this directory yet; add one (mirroring `evidence.js`'s
    `purgeOldEvidence`) if it grows large enough to matter.
  - **No separate credential** — `sheetImage.js` downloads the range-export
    PDF authenticated as the sheets-writer service account (an OAuth Bearer
    token minted the same way every other Sheets API call in this pipeline
    already authenticates, plus `drive.readonly` scope), not a real human
    Google login. This relies on Google's per-range PDF export endpoint
    accepting a service-account token the same way it accepts a signed-in
    user's session — plausible (it's gated by the same OAuth authorization
    as everything else, and the service account already has Editor access to
    the spreadsheet) but **unconfirmed against a live spreadsheet**, since
    this is an unofficial/undocumented endpoint whose auth behavior Google
    doesn't guarantee. If it 401s/403s on a real run
    (`SheetExportAccessError` in `sheetImage.js`, surfaced as its own Slack
    warning), the concrete things to check are the service account's actual
    sharing on that spreadsheet and whether the token really carries
    `drive.readonly` — not a login/session problem, since there is no login
    here.
  - **Confirmed working end-to-end live, 2026-08-15** — this took several
    live-test iterations to get right, each surfacing a real problem the
    unit tests couldn't have caught (they mock the network/process
    boundary; these were about what's actually on the other side of it):
    the service-account Bearer token approach for the range-export download
    itself worked on the first try, but `EAF`/`EAL-MORN` initially failed
    with "tab not found" (they live in HOC-REPORTS-final, not the master
    sheet — since fixed in `config.js`); then Chromium's PDF handling failed
    two different ways (direct navigation downloads instead of rendering;
    an `<embed>` wrapper renders "Couldn't load plugin" — Playwright's
    bundled Chromium has no working PDF viewer available at all here), fixed
    by switching to `pdftocairo` (poppler-utils) instead, which needed no
    workaround; then Slack's `files.getUploadURLExternal` rejected a JSON
    body with `invalid_arguments` (needs form-urlencoded, unlike every other
    Slack API call here) — fixed in `slackFiles.js`. What's left to tune, if
    anything, is purely cosmetic: the export URL's `portrait`/`gridlines`/
    margin parameters in `sheetImage.js`, and `PDF_RENDER_DPI` (currently
    150) if the images come out too small/large for Slack's inline preview.
  - **Stale-data risk is low, not an `IMPORTRANGE` situation**: `EAF`,
    `EAL-MORN`, and `EAL-EOD` all live in **HOC-REPORTS-final** — the same
    spreadsheet as `EAF Data Entry`/`EAL Data Entry`/etc. (confirmed live
    2026-08-15; an earlier draft of this note incorrectly assumed these
    dashboard tabs were in the master sheet and reached across spreadsheets
    via `IMPORTRANGE` to read HOC-REPORTS-final — they don't need to, since
    they're already in it). Their lookups are plain same-spreadsheet
    formulas against rows this pipeline just wrote/corrected via the Sheets
    API, which Google recalculates essentially immediately — the only
    genuine risk is if the range export happens to run before that
    recalculation has visually settled, which `captureAndPostDashboardImages`'s
    5-second delay (`SHEET_IMAGE_SETTLE_DELAY_MS`) should comfortably cover.
    Widen it if a posted image ever shows numbers that don't match what was
    just written, but there's no structural reason to expect that here.
- **LCC (EAL Dashboard) scraping notes:**
  - Unlike EAF (one finalization race on a single view), the LCC dashboard's
    sections load independently and asynchronously — confirmed 2026-08-14
    that a fixed 2.5s wait after selecting a PERIOD caught the channel
    breakdown still showing the *previous* period's numbers after the KPI
    cards had already updated. `lccScraper.js` polls the whole page's text
    until it's identical across two consecutive reads AND contains the
    expected period+date badge (e.g. `"Yesterday\nAug 13 – Aug 13"`) before
    reading anything.
  - A run's LCC scrape/write is wrapped in its own try/catch inside
    `runLccMorning` (05:00/05:30) so an LCC-side failure only sends its own
    alert — it never blocks or fails the EAF pipeline that already succeeded
    in the same run. The 16:25 EOD run has no such fallback since it does
    nothing else.
  - `LCC_SNAPSHOT`'s Yesterday and Today blocks live at fixed row ranges
    (1–15 and 17–23) written independently by different runs — each is one
    or two identically-shaped 7-row Channel tables (title, blank, header, 3
    channels + Overall), so row count never varies. `writeLccBlock`
    (`sheetsClient.js`) still clears each block's full column range *and*
    resets `userEnteredFormat` before every write, not just once — confirmed
    2026-08-14 (while this tab still had more varied section shapes) that
    `values.update` never clears a cell it isn't given a value for, and that
    a cell which once held a percent-style value keeps rendering as a
    percentage even after a later run overwrites it with an unrelated plain
    number (a target of `35184044` rendered as `"3518404400.00%"`). Kept
    even now that every row is the same width, since nothing prevents a
    future reshape from hitting the same trap again.
  - Per-channel **Blended GM%** comes from drilling into a channel row (a
    truck-level breakdown headed by "Blended GM: X%") — the channel card
    itself only has Value/Share/delta, no GM. Browser back-navigation
    (`page.goBack()`) does not reliably restore this SPA's filter/period
    state after a drill-in (confirmed 2026-08-14 — the PERIOD bar and
    channel rows were simply gone afterward), so `lccScraper.js` gives each
    channel its own fresh page load + period reselect + click, same
    reload-from-scratch pattern as EAF's scraper and for the same reason.
    This means each scrape now does 4 page loads (main view + 3 channels)
    instead of 1, and a "MTD" scrape doubles that again — a full morning
    run's LCC portion takes a few minutes, not under one.
  - EBITDA has no per-channel equivalent anywhere on this dashboard — the
    channel drilldown only ever shows Blended GM%, confirmed by inspecting
    it directly — so every channel row's EBITDA column is `-`; only the
    Overall row (sourced from the topline KPI card, not any per-channel
    figure) has it.
  - The PERIOD filter's `"MTD"` option is used for the Yesterday block's
    second channel table. Its date-range badge always ends at *today*
    (whatever day the scrape actually runs), not at the target date being
    reported — a live, moving range rather than a fixed one — so
    `lccScraper.js` confirms it generically (any `"MTD\n<Mon D> – <Mon D>"`
    badge) instead of computing an exact expected end date.
  - `lccScraper.js` only ever reads a channel's revenue value and the
    per-channel/topline actuals needed for this table — achievement %,
    target, delta, share, the Revenue by Zone table, and Unzoned Revenue are
    all visible on the dashboard but intentionally not scraped, since none
    of them appear in `LCC_SNAPSHOT` anymore.
  - Each channel row's revenue is matched with its own independent regex
    (`matchChannelValue`), not one combined regex spanning all three rows —
    a wording/layout change to a single channel (renamed, reordered, an extra
    badge) now only nulls that one channel's value, instead of failing the
    whole match and nulling all three even though the other two rows were
    still perfectly readable on the same page.
