# One-time setup of hocreport on this PC. Start it with Setup.cmd.
# Downloads Node.js and Poppler into tools\, installs the npm packages and
# Chromium, then registers the five scheduled tasks (Windows asks for admin
# rights for that last step). Safe to run again: finished downloads are kept
# and the tasks are replaced.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # the progress bar makes downloads very slow in Windows PowerShell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root  = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Root 'tools'

# Pinned downloads, checked against these SHA-256 hashes.
$NodeVersion    = '22.23.5'
$NodeSha256     = '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3'
$PopplerVersion = '26.09.0'
$PopplerSha256  = '7a6f256a0ddf7536182246a5733331bf4677cbcc34f4663774947ad34556c8d0'

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

function Get-Zip($Name, $Url, $Sha256, $Inner) {
  $dest = Join-Path $Tools $Name
  if (Test-Path $dest) { Write-Host "$Name is already in tools\"; return }
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  $zip  = Join-Path $Tools "$Name.zip"
  $work = Join-Path $Tools "_unpack-$Name"
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash
  if ($actual -ne $Sha256) {
    Remove-Item $zip
    throw "The $Name download does not match its expected checksum (got $actual)."
  }
  if (Test-Path $work) { Remove-Item $work -Recurse -Force }
  New-Item -ItemType Directory -Path $work | Out-Null
  tar.exe -xf $zip -C $work
  if ($LASTEXITCODE -ne 0) { throw "Could not unpack $zip." }
  Move-Item -Path (Join-Path $work $Inner) -Destination $dest
  Remove-Item $work -Recurse -Force
  Remove-Item $zip
}

try {
  Step 'Checking this PC'
  foreach ($f in '.env', 'service-account.json') {
    if (-not (Test-Path (Join-Path $Root $f))) {
      throw "$f is missing from $Root. It holds the logins and must sit next to index.js."
    }
  }
  $tz = (Get-TimeZone).Id
  if ($tz -ne 'E. Africa Standard Time') {
    throw "This PC's time zone is '$tz'. The tasks fire by the PC clock, so first set it to (UTC+03:00) Nairobi in Settings > Time & language > Date & time."
  }
  if ($Root.Length -gt 60) {
    Write-Warning "The folder path is long ($Root). If setup fails with path errors, move the folder to C:\hocreport and run Setup.cmd again."
  }
  Write-Host "Folder: $Root"

  Step 'Node.js'
  Get-Zip 'node' "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $NodeSha256 "node-v$NodeVersion-win-x64"

  Step 'Poppler (turns the Sheet into the report images)'
  Get-Zip 'poppler' "https://github.com/oschwartz10612/poppler-windows/releases/download/v$PopplerVersion-0/Release-$PopplerVersion-0.zip" $PopplerSha256 "poppler-$PopplerVersion"

  $env:PATH = "$Tools\node;$Tools\poppler\Library\bin;$env:PATH"
  $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $Tools 'ms-playwright'

  Push-Location $Root
  try {
    Step 'npm packages'
    & "$Tools\node\npm.cmd" ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

    Step 'Chromium'
    & "$Tools\node\node.exe" 'node_modules\playwright\cli.js' install chromium
    if ($LASTEXITCODE -ne 0) { throw 'The Chromium download failed.' }
  } finally {
    Pop-Location
  }

  Step 'Scheduled tasks (Windows will ask for admin rights)'
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $register = Join-Path $PSScriptRoot 'register-tasks.ps1'
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$register`"", '-User', "`"$user`"")
  if ($p.ExitCode -ne 0) { throw "Registering the scheduled tasks failed (exit code $($p.ExitCode))." }

  Step 'Done'
  Write-Host "Five tasks are in Task Scheduler under the 'hocreport' folder, running as $user."
  Write-Host "The first run is at the next scheduled time. Logs go to $Root\cron.log"
  Write-Host 'See SETUP-WINDOWS.txt for how to do a test run.'
} catch {
  Write-Host ''
  Write-Host "SETUP STOPPED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
