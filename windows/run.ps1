# Runs one hocreport job. The scheduled tasks call it with a -Mode for their
# run, and output is appended to cron.log, as on the Linux boxes.
# Backfill.cmd calls it with -Mode backfill -From -To [-Dry], and output then
# goes to the screen (run.log still gets every line).
#
# Jobs are taken one at a time through a named mutex. When the PC comes back
# after missing several runs, Windows starts them all at once, and without
# this index.js's run.lock would abort all but one with a failure alert. It
# also stops a backfill and a scheduled run scraping at the same moment.
param(
  [ValidateSet('report', 'verify', 'catchup0600', 'catchup0655', 'eod', 'backfill')]
  [string]$Mode = 'report',
  [string]$From,
  [string]$To,
  [switch]$Dry
)
$ErrorActionPreference = 'Stop'

$Root  = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Root 'tools'
$flag = @{
  report      = ''
  verify      = '--verify'
  catchup0600 = '--catchup=0600'
  catchup0655 = '--catchup=0655'
  eod         = '--eod'
  backfill    = ''
}[$Mode]

$env:PATH = "$Tools\node;$Tools\poppler\Library\bin;$env:PATH"
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $Tools 'ms-playwright'
$env:TZ = 'Africa/Dar_es_Salaam'
Set-Location $Root

$mutex = New-Object System.Threading.Mutex($false, 'Global\hocreport-run')
$owned = $false
$code = 1
try {
  try {
    $owned = $mutex.WaitOne(0)
    if (-not $owned) {
      if ($Mode -eq 'backfill') { Write-Host 'A scheduled run is in progress; waiting for it to finish...' }
      $owned = $mutex.WaitOne([TimeSpan]::FromMinutes(90))
    }
  } catch [System.Threading.AbandonedMutexException] {
    $owned = $true  # the previous holder was killed; the mutex is ours now
  }
  # If the wait timed out, run anyway and let index.js's own lock decide.
  if ($Mode -eq 'backfill') {
    $nodeArgs = @('backfillRange.js', '--from', $From, '--to', $To)
    if ($Dry) { $nodeArgs += '--dry' }
    & node @nodeArgs
  } else {
    cmd.exe /c "node index.js $flag >> cron.log 2>&1"
  }
  $code = $LASTEXITCODE
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
exit $code
