const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const { buildRangeExportUrl, fetchRangeExportPdf, renderPdfToPng, SheetExportAccessError } = require('../sheetImage');

function withMockedFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return fn().finally(() => {
    global.fetch = original;
  });
}

test('buildRangeExportUrl builds Google Sheets\' per-range PDF export URL', () => {
  const url = buildRangeExportUrl('SHEET_ID_123', 456, 'D2:Q46');
  assert.ok(url.startsWith('https://docs.google.com/spreadsheets/d/SHEET_ID_123/export?'));
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('format'), 'pdf');
  assert.equal(parsed.searchParams.get('gid'), '456');
  assert.equal(parsed.searchParams.get('range'), 'D2:Q46');
  assert.equal(parsed.searchParams.get('fitw'), 'true');
});

test('buildRangeExportUrl requests a clean crop: no titles/margins/page numbers, gid 0 included', () => {
  const url = buildRangeExportUrl('ID', 0, 'A1:B2');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('gid'), '0'); // falsy gid must still appear, not be dropped
  assert.equal(parsed.searchParams.get('sheetnames'), 'false');
  assert.equal(parsed.searchParams.get('printtitle'), 'false');
  assert.equal(parsed.searchParams.get('pagenumbers'), 'false');
  assert.equal(parsed.searchParams.get('top_margin'), '0.00');
});

test('fetchRangeExportPdf sends the access token as a Bearer header and returns the PDF bytes', async () => {
  const seen = [];
  const pdfBytes = Buffer.from('%PDF-1.4 fake');
  const result = await withMockedFetch(
    async (url, opts) => {
      seen.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-type' ? 'application/pdf' : null) },
        arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength),
      };
    },
    () => fetchRangeExportPdf('https://example.com/export', 'fake-token', 'EAF', 'D2:Q46')
  );
  assert.deepEqual(result, pdfBytes);
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer fake-token');
});

test('fetchRangeExportPdf throws SheetExportAccessError on a 403 (access problem, not a login problem)', async () => {
  await assert.rejects(
    withMockedFetch(
      async () => ({
        ok: false,
        status: 403,
        headers: { get: () => 'text/html' },
        text: async () => 'The caller does not have permission',
      }),
      () => fetchRangeExportPdf('https://example.com/export', 'fake-token', 'EAF', 'D2:Q46')
    ),
    (err) => err instanceof SheetExportAccessError
  );
});

test('fetchRangeExportPdf throws a plain Error for a non-access, non-PDF response', async () => {
  await assert.rejects(
    withMockedFetch(
      async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => 'unexpected HTML',
      }),
      () => fetchRangeExportPdf('https://example.com/export', 'fake-token', 'EAF', 'D2:Q46')
    ),
    (err) => !(err instanceof SheetExportAccessError) && /did not return a PDF/.test(err.message)
  );
});

// Regression test: a transient network failure (fetch() itself throwing, not
// just returning a bad response) used to surface as an unhelpful bare "fetch
// failed" with no indication of what actually went wrong (confirmed in
// production, 2026-08-15 — a net::ERR_NETWORK_CHANGED blip elsewhere in the
// same run). The real detail lives in err.cause, which fetch never puts in
// its own message.
test('fetchRangeExportPdf surfaces the underlying cause when fetch() itself throws (network failure)', async () => {
  await assert.rejects(
    withMockedFetch(
      async () => {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ENOTFOUND' };
        throw err;
      },
      () => fetchRangeExportPdf('https://example.com/export', 'fake-token', 'EAF', 'D2:Q46')
    ),
    /ENOTFOUND/
  );
});

function withMockedExecFile(handler, fn) {
  const original = childProcess.execFile;
  childProcess.execFile = handler;
  return fn().finally(() => {
    childProcess.execFile = original;
  });
}

test('renderPdfToPng invokes pdftocairo with -singlefile and a PNG-extension-stripped output prefix', async () => {
  const calls = [];
  await withMockedExecFile(
    (command, args, cb) => {
      calls.push({ command, args });
      cb(null, '', '');
    },
    () => renderPdfToPng('/tmp/in.pdf', '/tmp/out.png')
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pdftocairo');
  assert.deepEqual(calls[0].args, ['-png', '-singlefile', '-r', '300', '/tmp/in.pdf', '/tmp/out']);
});

test('renderPdfToPng gives an actionable error when pdftocairo isn\'t installed (ENOENT)', async () => {
  await assert.rejects(
    withMockedExecFile(
      (command, args, cb) => {
        const err = new Error('spawn pdftocairo ENOENT');
        err.code = 'ENOENT';
        cb(err);
      },
      () => renderPdfToPng('/tmp/in.pdf', '/tmp/out.png')
    ),
    /poppler-utils/
  );
});

test('renderPdfToPng surfaces pdftocairo\'s stderr on a real failure', async () => {
  await assert.rejects(
    withMockedExecFile(
      (command, args, cb) => {
        cb(new Error('Command failed'), '', 'Syntax Error: Couldn\'t read xref table\n');
      },
      () => renderPdfToPng('/tmp/in.pdf', '/tmp/out.png')
    ),
    /Couldn't read xref table/
  );
});

// Real (unmocked) integration test — poppler-utils' actual availability and
// behavior is exactly what silently went wrong before this rewrite
// (Chromium's PDF viewer being unavailable produced no error at all, just a
// broken-looking "successful" image — see git history / README notes on
// this). This exercises the real `pdftocairo` binary against a minimal,
// hand-built one-page PDF (200x100pt) and checks the actual output
// dimensions at PDF_RENDER_DPI (150), not just that a file appeared.
function buildMinimalOnePagePdf() {
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) {
    offsets.push(body.length);
    body += o + '\n';
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return body;
}

test('renderPdfToPng really rasterizes a one-page PDF at the expected resolution (no mocks)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-image-test-'));
  const pdfPath = path.join(tmpDir, 'in.pdf');
  const pngPath = path.join(tmpDir, 'out.png');
  fs.writeFileSync(pdfPath, buildMinimalOnePagePdf());
  try {
    await renderPdfToPng(pdfPath, pngPath);
    assert.ok(fs.existsSync(pngPath), 'expected a PNG to be written');
    const header = fs.readFileSync(pngPath).subarray(0, 24);
    assert.equal(header.readUInt32BE(0x10), 834); // width: 200pt @ 300dpi ≈ 834px
    assert.equal(header.readUInt32BE(0x14), 417); // height: 100pt @ 300dpi ≈ 417px
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
