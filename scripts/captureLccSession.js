// Manual entry point — re-run whenever you want to re-link the LCC session
// by hand:
//   node scripts/captureLccSession.js
// Set PLAYWRIGHT_HEADED=1 to watch it. The login flow itself now lives in
// ../sessionCapture.js so the scrapers can also call it unattended when they
// find the stored session expired mid-run; this file stays as the documented
// manual override.
require('dotenv').config();
const { captureSession } = require('../sessionCapture');

captureSession('lcc')
  .then(() => {
    console.log('Session captured successfully.');
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
