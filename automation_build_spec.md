# HOC Sales Reporting Automation — Build Spec

> **Note to whoever/whatever implements this (e.g. Claude Code):** This spec is
> complete except for the placeholders in §0 and the CSS selectors in §4/§5.2,
> which Erick will fill in directly. If you're an AI agent picking this up:
> read the whole document first, don't start writing code until §0 is filled
> in, and if the selectors are still missing when you get to §5.2, ask Erick
> to inspect the live page rather than guessing at selector names.

## 0. Configuration Placeholders

Fill these in before implementation begins. Do **not** commit this file to
version control once real values are added — store credentials in an untracked
`.env` file instead and reference this section as the checklist of what's needed.

```
EAF DASHBOARD
  URL:                 <https://scc.eafoods.com/>
  Username:            <admin@eafoods.com>
  Password:            <Moweb@DMS@UAT1>

GOOGLE SHEETS
  Master Spreadsheet ID (the long ID in the sheet's URL between /d/ and /edit):
                       <16CIlRWP4qoL_9n1IujG3Aiy-TIq_U_Fquq882So0c2E>
```

---

## 1. Objective

Every morning, produce a fully-populated **daily branch performance snapshot** —
per-product sales metrics pulled from Google Sheets, plus gross margin (GM) figures
pulled from a web dashboard — with zero manual data entry. The output is a live
Google Sheet the user reads from and copies numbers out of manually; this
automation does **not** need to deliver the result anywhere (no WhatsApp/email
step required, unlike a design considered earlier in this project).

Two data sources feed one destination:

```
[4 branch data sheets] --IMPORTRANGE--> [Master Spreadsheet: 4 branch tabs]
                                              |
                                              v
                                   [4x _SUMMARY tabs] (all-time, per product)
                                              |
                                              v
                                   [DAILY_SNAPSHOT tab] <-- [EAF dashboard scrape]
                                    (date-driven, per product + GM %)
```

---

## 1a. Google Service Account Setup (one-time, not yet done)

1. console.cloud.google.com → create/select a project.
2. APIs & Services → Library → enable **Google Sheets API**.
3. APIs & Services → Credentials → Create Credentials → Service Account →
   name it (e.g. `sheets-writer`) → Create and Continue → skip role → Done.
4. Open the service account → Keys tab → Add Key → Create new key → JSON →
   downloads `service-account.json`. Treat as a secret — never commit it.
5. Copy the `client_email` field from that JSON (looks like
   `sheets-writer@PROJECT.iam.gserviceaccount.com`).
6. Share the master spreadsheet with that email address, permission = **Editor**.

## 1b. Infrastructure plan

- **Phase 1 (now)**: cron on Erick's own Linux machine, per the original
  "no Docker" decision.
- **Phase 2 (planned)**: migrate the same Node script + cron setup to a small
  always-on VPS once ready — no code changes needed, just re-run the setup
  steps (session capture, `.env`, cron entry) on the new host.

## 1c. Failure alerting — confirmed: WhatsApp/email, not just a log file
When a run fails (site down, session expired, Sheets write error), the
pipeline must actively notify Erick, not just write to a local log. Given the
existing WhatsApp integration already scoped in an earlier phase of this
project (`whatsapp-web.js` with a persisted session), the simplest path is:
reuse that same sender to push a short failure message (e.g. "❌ GM scrape
failed at 06:03 — site login redirected, check session") to the same
recipient/group already configured for other reports. Email via a transactional
SMTP service is a fallback option if WhatsApp itself is what's down.

---

## 2. Data source 1: Google Sheets (branch sales data)

### 2.1 Structure
- One **master spreadsheet** contains 4 tabs, one per branch: `BUNJU`, `KINYEREZI`,
  `DODOMA`, `ONJA`.
- Each tab is populated via `IMPORTRANGE` from that branch's own source spreadsheet.
- Header row is **row 4**; data starts at **row 5**. Rows 1–3 hold merged section
  labels (`ROUTE DETAILS>>>`, `SALES>>>`, `CREDIT>>>`, `DISC>>>`, `COLL>>>`) — decorative,
  not used by any formula.

### 2.2 Column map (consistent across all 4 branch tabs)

| Col | Field | Used for |
|---|---|---|
| B | SNO. | row identity / "last row" detection |
| C | Date | date filtering |
| K | Product | grouping |
| L | Product Variant | grouping |
| N | Total Load Out | Total Loadout, Avg Loadout Qty |
| Q | Return | Total Returns |
| S | Qty Sold | weighted ASP denominator |
| U | Total Net Sales | Total Revenue, weighted ASP numerator |
| AH | Total Discount | Total Discount (already signed negative in source — preserve as-is, do not flip sign) |

### 2.3 Known `IMPORTRANGE` gotcha (already solved, don't reintroduce)
`IMPORTRANGE` with an unbounded column reference (`A:BB`) can throw
**"Result too large"** because Sheets resolves the *source* sheet's used range,
which can balloon from stray formatting far outside the real data. Fix: always
bound `IMPORTRANGE` with an explicit row cap (e.g. `A1:BB30000`), and periodically
verify with `Ctrl+End` on the source sheet that the used range matches the real
data extent — trim rows/columns physically (not just clear contents) if not.

### 2.4 Business rules / grouping decisions already made
- **BUNJU, KINYEREZI, DODOMA**: group by `Product` + `Product Variant` as entered —
  these product-field values are reliable.
- **ONJA**: the raw `Product` field is unreliable/inconsistently tagged (e.g. a row
  tagged "Premium Rice" carrying a "Normal Rice" variant, or vice versa). Group by
  **`Product Variant` only**, and force-label the product as **"Rice"**. When the
  user wants ONJA fully collapsed (no variant breakdown), sum across all variants
  into one "Rice" line — used for the DAILY_SNAPSHOT view.
- Per user confirmation: **only DODOMA legitimately runs two products** (Banana +
  Potato). BUNJU's occasional Potato/Horeca rows with ~zero revenue are most
  likely stray/erroneous entries at the source, not a real product line — do not
  silently strip them, but don't treat them as meaningful either.
- **Average Selling Price is always a weighted average**: `SUM(Total Net Sales) /
  SUM(Qty Sold)` for the filtered rows — never a plain average of the row-level
  ASP column, which would be skewed by mixed transaction sizes.
- **Discount** = `SUM(Total Discount)` for the filtered rows, sign preserved as
  negative (matches source convention — a discount reduces revenue).
- **Loadout**: "Total Loadout" = `SUM(Total Load Out)`. "Avg Loadout Qty" =
  `AVERAGE(Total Load Out)` (average per trip/route on that day) — these are two
  distinct metrics, not duplicates.

---

## 3. Existing spreadsheet artifacts (already built, do not rebuild from scratch)

### 3.1 `{BRANCH}_SUMMARY` tabs (x4)
All-time totals per Product+Variant (ONJA per Variant only), using live
`SUMIFS`/`AVERAGEIFS` formulas referencing the branch tab with headroom (last
real row + 1000) so new appended rows are picked up automatically without
editing formulas. Columns: Product, Product Variant, Total Revenue, Avg Selling
Price, Total Discount, Avg Loadout Qty, Total Loadout, Total Returns, plus a
TOTAL row.

### 3.2 `DAILY_SNAPSHOT` tab
- **Cell `B1`**: the control date (format `DD/MM/YYYY`). All tables below are
  driven by this one cell via `SUMIFS` date-matching — changing it changes
  every branch's numbers instantly.
- One section per branch, each with:
  - A header row with the branch name (col A) and, beside it in **col J/K**,
    two labeled manual-entry cells:
    - `Gross Margin (Daily, %)` → value cell (currently `K{header_row}`)
    - `Gross Margin (MTD, %)` → value cell (currently `K{header_row+1}`)
    - Both formatted as percentage (`0.0%`), yellow fill = manual/external input.
  - A product table (cols A–H) identical in structure to the `_SUMMARY` tabs,
    but filtered additionally by `B1`'s date.
  - A TOTAL row.

**Current row anchors** (as of last build — see §5.1 caveat, these shift if the
sheet is regenerated with different product/variant lists):

| Branch | Header row | GM Daily cell | GM MTD cell |
|---|---|---|---|
| BUNJU | 3 | K3 | K4 |
| KINYEREZI | 13 | K13 | K14 |
| DODOMA | 19 | K19 | K20 |
| ONJA | 25 | K25 | K26 |

---

## 4. Data source 2: EAF Sales Command Center (web dashboard)

- Login-gated dashboard via a **simple username/password form** (no 2FA/CAPTCHA
  confirmed) — Playwright can automate this directly with `page.fill()` on the
  form fields, no manual-intervention step needed beyond the initial session
  capture.
- "Branches Performance" table, columns include:
  `Achievement Score`, `GM` (gross margin %), `Return Rate`, `Discount`,
  `Net Utilization`. Only **GM** is in scope for this automation; the others are
  visible but currently unused (kept in mind for future extension).
- Branch names on the dashboard: `Dodoma`, `Bunju`, `Kinyerezi`, `Onja Channel`
  — map `Onja Channel` → `ONJA` sheet tab.
- A dropdown (top right, currently defaults to **"Today"**) controls the date
  range. It must also support switching to a **month-to-date** view — exact
  option label/selector unconfirmed, needs live inspection.

### 4.1 Critical timing quirk — do not get this wrong
**The dashboard's "Today" figure for date X is only finalized by ~5:00 AM on
day X+1.** In other words: if the scraper runs on the morning of day X+1 and
reads the "Today" filter, the number shown is actually **day X's** completed
GM — not "today" in the literal sense. Practical implication:

- The scraper must run **after ~5:00–5:30 AM** (build in a safety buffer, e.g.
  6:00 AM) to guarantee the prior day's figure is finalized.
- The date the scraped GM value applies to is **`run_date - 1 day`**, always.
- The `DAILY_SNAPSHOT!B1` control cell must be set to `run_date - 1 day` by the
  automation itself on every run (confirmed requirement — always overwrite,
  don't ask, don't leave stale).

---

## 5. Automation requirements

### 5.1 GM cell targeting strategy — **confirmed: label-based lookup**
On each run, the writer script scans column A of `DAILY_SNAPSHOT` for each
branch name (`BUNJU`, `KINYEREZI`, `DODOMA`, `ONJA`), then writes the two GM
values at a fixed offset from that row (same row = Daily, +1 row = MTD,
column K) — resilient to the sheet being regenerated with a different number
of product rows, no manual re-pointing required. Named ranges were considered
and rejected in favor of this approach.

### 5.2 Pipeline steps (daily, scheduled)

1. **Trigger**: cron, `0 6 * * *` (6:00 AM) on the user's own always-on Linux
   machine (per earlier infra decision — no Docker, no cloud VM for now).
2. **Compute target date** = `today - 1 day`.
3. **Playwright, headless, persisted Google session** (already scoped in an
   earlier phase of this project) — not required for this piece unless the
   branch sheet screenshot/export step from the original workflow discussion
   is later revived. Not needed for GM scraping itself.
4. **Playwright, headless, persisted EAF dashboard login session**:
   - Navigate to the dashboard's "Branches Performance" view.
   - Confirm the date filter is on "Today" (matches target date per the timing
     rule above) — if the site requires explicit date selection rather than a
     rolling "Today", set it explicitly to `target_date`.
   - Scrape the `GM` column value for each of the 4 rows (`Dodoma`, `Bunju`,
     `Kinyerezi`, `Onja Channel`).
   - Switch the filter to month-to-date view and re-scrape the same 4 `GM`
     values (now representing MTD). **Confirmed: run this every day**, even
     though most days only add one incremental day's worth of MTD movement —
     simplicity over optimization.
5. **Write to Google Sheets** (service account, Sheets API):
   - Set `DAILY_SNAPSHOT!B1` = `target_date`.
   - Locate each branch's GM Daily/MTD cells (per §5.1's chosen strategy) and
     write the two scraped percentages (store as raw decimal, e.g. `0.225` for
     22.5%, matching existing cell format `0.0%`).
6. **No delivery step.** Pipeline ends once the sheet is written — the user
   pulls numbers from `DAILY_SNAPSHOT` manually into wherever they need them
   next.

### 5.3 Error handling
- **EAF session expired** (redirected to login) → abort with a clear log
  message; do not write partial/stale GM data.
- **Any one branch's GM value missing/unparseable on the page** → do not zero
  it out or guess; leave that specific cell untouched and flag it in the run
  log, so a gap is visible rather than silently wrong.
- **Google Sheets write failure** → retry once, then log and exit non-zero so
  a monitoring/alerting layer (if added later) can catch it.
- Log every run's outcome (success/failure, which branches succeeded) to a
  local file for later review — no need for real-time alerting yet.

---

## 6. Open items — need answers/access before implementation can start

1. **EAF dashboard URL** — still needed (placeholder added in §0).
2. **Live DOM access** to the dashboard to capture exact CSS selectors for:
   - the username/password form fields and submit button,
   - the date-range dropdown and its "Today" / month-to-date options,
   - the GM value cell per branch row in the Branches Performance table.
3. **Master spreadsheet ID** — still needed (placeholder added in §0).
4. **Service account not yet created** — walkthrough provided in §1a; needs to
   actually be done and the resulting JSON key placed somewhere the script can
   read it, before any Sheets-write code can be tested.

Resolved: GM cell targeting → label-based lookup (§5.1). MTD scrape cadence →
daily (§5.2). Login flow → simple username/password, no 2FA/CAPTCHA (§4).
Hosting → own Linux now, VPS later, no code changes needed for the migration
(§1b). Failure handling → WhatsApp/email alert, not just a log (§1c).

---

## 7. Implementation deliverables checklist

For whoever builds this — the expected file set (Node.js, CommonJS, matching
patterns from an earlier phase of this project):

- [ ] `package.json` — deps: `googleapis`, `playwright`, `whatsapp-web.js`,
      `qrcode-terminal`, `dotenv`
- [ ] `.env` — populated from §0's placeholders + `WHATSAPP_RECIPIENT`
- [ ] `config.js` — central config: spreadsheet ID, branch name mapping
      (`Onja Channel` → `ONJA`), selectors (filled in once available), sheet
      tab/column references
- [ ] `sheetsClient.js` — service-account auth (`google-auth-library` via
      `googleapis`), a `findBranchRow(sheets, branchName)` label-lookup
      helper (§5.1), and a `writeGmValues(sheets, branch, daily, mtd)` writer
      that also sets `DAILY_SNAPSHOT!B1` to `yesterday()`
- [ ] `scraper.js` — Playwright: persisted-session login (capture script run
      once manually, reused headlessly after), scrape GM for both "Today" and
      MTD views, return `{ branch: { daily, mtd } }` for all 4 branches
- [ ] `alert.js` — on any pipeline failure, send a WhatsApp message (reuse
      `whatsapp-web.js` pattern) describing what failed and when
- [ ] `index.js` — orchestrator: compute yesterday's date → scrape → write to
      Sheets → on any thrown error, call `alert.js` before exiting non-zero
- [ ] `scripts/captureEafSession.js` — one-time manual login capture (mirror
      of the site-session pattern from the earlier automation phase)
- [ ] `README.md` — setup steps (service account already done; site session
      capture; WhatsApp QR link; cron entry for 6:00 AM)
- [ ] Cron entry: `0 6 * * * cd /path/to/project && /usr/bin/node index.js`

Not needed for this phase (descoped, see §1 objective): screenshot export of
the calculated range, and any Sheets→WhatsApp *report* delivery — this
pipeline's only output is the correctly populated spreadsheet.
