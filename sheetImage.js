const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { google } = require('googleapis');
const config = require('./config');
const { log } = require('./logger');

// Thrown when the export request is rejected for auth/access reasons (401/
// 403) — distinct from other failures because the fix is different: check
// that the sheets-writer service account really is shared on the target
// spreadsheet (same one-time setup this pipeline's Sheets API calls already
// rely on), not a login/session problem.
class SheetExportAccessError extends Error {}

// Builds Google Sheets' own (unofficial, but long-stable and widely used)
// per-range PDF export URL — the same request a browser makes for
// File > Print > "Selected cells" > Export. There's no official Sheets/Drive
// API for exporting a single named range as an image; this is the one
// mechanism that reliably crops to an exact A1 range instead of the whole
// tab. fitw scales the range to one page width; margins/gridlines/titles are
// tuned for a clean crop rather than a full printable page layout. `range` is
// plain A1 notation (no sheet-name prefix) since gid already identifies the
// sheet.
function buildRangeExportUrl(spreadsheetId, gid, range) {
  const params = new URLSearchParams({
    format: 'pdf',
    gid: String(gid),
    range,
    size: 'A4',
    fitw: 'true',
    portrait: 'false',
    top_margin: '0.00',
    bottom_margin: '0.00',
    left_margin: '0.00',
    right_margin: '0.00',
    sheetnames: 'false',
    printtitle: 'false',
    pagenumbers: 'false',
    gridlines: 'true',
    fzr: 'false',
  });
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?${params.toString()}`;
}

// Resolves a tab NAME to its numeric gid via the same Sheets API client the
// rest of the pipeline already uses (service account) — the export URL above
// addresses sheets by gid, not name, and gid isn't something worth hardcoding
// per target since it isn't visible anywhere in a tab's own UI.
async function resolveGid(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const found = (meta.data.sheets || []).find((s) => s.properties.title === tabName);
  if (!found) throw new Error(`sheetImage: tab "${tabName}" not found in spreadsheet ${spreadsheetId}`);
  return found.properties.sheetId;
}

// Mints an OAuth access token for the same service account
// (config.sheets.serviceAccountKeyPath) every other Sheets API call in this
// pipeline already uses, with drive.readonly added — the per-range PDF
// export endpoint below is technically a Drive file-export operation, gated
// by the same OAuth authorization Google uses everywhere else. Since the
// service account already has Editor access to the target spreadsheet (this
// pipeline's existing one-time setup), this reuses that access directly
// instead of needing a separate real-Google-account browser login for
// screenshotting — no extra credential/session for this feature at all.
// Unofficial/undocumented endpoint, so this is unconfirmed against a live
// spreadsheet until the first real run; if it 401s/403s, the concrete things
// to check are "is drive.readonly actually granted" and "is the service
// account really shared on this spreadsheet" (see SheetExportAccessError
// below), not a login problem — there is no login here.
async function getExportAccessToken() {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.sheets.serviceAccountKeyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse && tokenResponse.token;
  if (!token) {
    throw new Error('sheetImage: failed to obtain an OAuth access token for the sheets-writer service account.');
  }
  return token;
}

// Fetches the range-export PDF bytes given a pre-resolved access token — kept
// separate from captureSheetRangeImage (and the token/gid resolution above
// it) so the HTTP response handling is unit-testable with a fixed token and
// mocked fetch, without needing real Google auth or a browser.
async function fetchRangeExportPdf(exportUrl, accessToken, tab, range) {
  let response;
  try {
    response = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    // Node's fetch (undici) throws a bare "fetch failed" for any
    // network-level problem (DNS, TLS, connection reset, timeout) — the
    // actually useful detail lives in err.cause, which fetch never puts in
    // the message itself. Surfaced explicitly so a transient network blip
    // is distinguishable from a real problem without re-reading source.
    const causeDetail = err.cause ? `: ${err.cause.code || err.cause.message || err.cause}` : '';
    throw new Error(`Sheets range export request for ${tab}!${range} failed to reach docs.google.com${causeDetail} (${err.message})`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('application/pdf')) {
    const bodySnippet = (await response.text().catch(() => '')).slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      throw new SheetExportAccessError(
        `Sheets range export for ${tab}!${range} was denied (HTTP ${response.status}) — confirm the sheets-writer service account has at least Viewer access to this spreadsheet, and that drive.readonly scope was granted. Response: ${bodySnippet}`
      );
    }
    throw new Error(
      `Sheets range export for ${tab}!${range} did not return a PDF (status ${response.status}, content-type "${contentType}"): ${bodySnippet}`
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

// Resolution for the rasterized PNG. pdftocairo's own default is 150 DPI —
// legible but visibly soft for small text/thin gridlines once posted to
// Slack (confirmed live 2026-08-15). 300 is standard print-quality
// resolution: on an A4 landscape page (buildRangeExportUrl's
// size:A4/portrait:false) that's roughly 3510x2480px, sharp even when
// zoomed in on a phone. Trade-off is a bigger PNG (roughly 4x the pixels of
// 150 DPI) — still comfortably within Slack's upload limits for a
// spreadsheet screenshot; lower this if upload time/file size ever matters
// more than crispness.
const PDF_RENDER_DPI = 300;

// Thin promise wrapper around child_process.execFile, rather than
// util.promisify(execFile) captured once at module load — promisify would
// bind to the execFile reference at require-time, permanently, which is not
// mockable from a test. Looking up childProcess.execFile fresh on every call
// (a plain property access) means a test can monkey-patch it beforehand,
// same principle as this module's own use of the global fetch.
function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// Rasterizes a single-page PDF into a PNG via poppler's pdftocairo.
// Chromium was tried first and rejected: page.goto() straight to a local
// PDF triggers a download instead of rendering it ("Download is starting"),
// and wrapping it in an <embed type="application/pdf"> to sidestep that
// renders "Couldn't load plugin" instead — both confirmed live 2026-08-15,
// meaning Playwright's bundled Chromium has no working PDF viewer available
// in this build, in either form, and the second failure mode is silent (no
// thrown error, just a broken-looking image that "succeeds"). pdftocairo is
// a mature, dedicated PDF rasterizer with no such plugin-availability
// problem. Requires poppler-utils installed on the host (already present
// here; `apt-get install poppler-utils` on Debian/Ubuntu) — a system-level
// dependency alongside Playwright's own browser install (`npx playwright
// install --with-deps chromium`), not something `npm install` alone
// provides, and a real ENOENT failure if it's missing rather than a silent
// bad image.
async function renderPdfToPng(pdfPath, outputPath) {
  // pdftocairo's -singlefile writes exactly `<prefix>.png` for a
  // single-page PDF (no "-1" page-number suffix it would otherwise append).
  const outputPrefix = outputPath.replace(/\.png$/i, '');
  try {
    // NOT passing -antialias best here: tried it alongside the 300 DPI bump
    // below and it corrupted text into garbled/overlapping glyphs (confirmed
    // 2026-08-15, visually, against a real range — 300 DPI alone renders the
    // same range perfectly). Whatever's going on there (a cairo/poppler
    // "best" mode bug, most likely), pdftocairo's plain default antialiasing
    // already looks sharp at 300 DPI, so there's no reason to reach for it.
    await execFileAsync('pdftocairo', ['-png', '-singlefile', '-r', String(PDF_RENDER_DPI), pdfPath, outputPrefix]);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `sheetImage: "pdftocairo" not found on PATH — install poppler-utils (e.g. "apt-get install poppler-utils") to render dashboard-image PDFs.`
      );
    }
    throw new Error(`sheetImage: pdftocairo failed to render ${pdfPath}: ${(err.stderr || err.message || '').toString().trim()}`);
  }
}

// Unlike run.log/cron.log (logger.js's size-based rotation) or evidence.js's
// own 60-day purge, dashboard-image PNGs (one per configured target, 3
// scheduled runs a day) had no cleanup path at all — unbounded disk growth,
// same class of gap evidence.js was already written to close for its own
// directory. Mirrors evidence.js's retention window: 60 days comfortably
// covers this pipeline's MTD-lookback use case plus a wide margin for
// late-noticed discrepancies, without keeping every screenshot forever.
// Best-effort: a cleanup failure (unreadable dir entry, permissions) is
// logged, not thrown — housekeeping must never take down the image capture
// this runs alongside.
const MAX_IMAGE_AGE_MS = 60 * 24 * 60 * 60 * 1000;

function purgeOldDashboardImages(outputDir) {
  let entries;
  try {
    entries = fs.readdirSync(outputDir);
  } catch (err) {
    return; // dir doesn't exist yet — nothing to purge
  }
  const cutoff = Date.now() - MAX_IMAGE_AGE_MS;
  let purged = 0;
  for (const entry of entries) {
    const entryPath = path.join(outputDir, entry);
    try {
      const stat = fs.statSync(entryPath);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(entryPath);
        purged++;
      }
    } catch (err) {
      log(`sheetImage: failed to check/purge ${entryPath}: ${err.message}`);
    }
  }
  if (purged > 0) log(`sheetImage: purged ${purged} dashboard image(s) older than ${MAX_IMAGE_AGE_MS / 86400000} days.`);
}

// Captures a single {tab, range} as a PNG at outputPath:
//   1. Resolve the tab's gid via the Sheets API.
//   2. Fetch Google's per-range PDF export, authenticated as the
//      sheets-writer service account (see getExportAccessToken) — a plain
//      HTTPS request.
//   3. Write those bytes to a temp .pdf file and rasterize it with
//      pdftocairo (see renderPdfToPng) — no browser involved anywhere in
//      this function, and no Google auth needed for the rasterization step
//      either, since it operates purely on the local temp file.
async function captureSheetRangeImage(sheets, { spreadsheetId, tab, range }, outputPath) {
  const gid = await resolveGid(sheets, spreadsheetId, tab);
  const exportUrl = buildRangeExportUrl(spreadsheetId, gid, range);
  const accessToken = await getExportAccessToken();
  const pdfBuffer = await fetchRangeExportPdf(exportUrl, accessToken, tab, range);

  const tmpPdfPath = path.join(os.tmpdir(), `sheet-image-${process.pid}-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmpPdfPath, pdfBuffer);
    await renderPdfToPng(tmpPdfPath, outputPath);
    return outputPath;
  } finally {
    fs.unlink(tmpPdfPath, () => {});
  }
}

module.exports = {
  captureSheetRangeImage,
  buildRangeExportUrl,
  fetchRangeExportPdf,
  renderPdfToPng,
  purgeOldDashboardImages,
  SheetExportAccessError,
};
