# Registers hocreport's five daily runs in Task Scheduler, in a folder named
# \hocreport\. setup.ps1 runs this with admin rights; running it again
# replaces the tasks.
#
# The tasks run as -User whether or not anyone is signed in, without storing
# a password (S4U). They wake the PC from sleep if wake timers are allowed,
# and a run missed while the PC was off starts as soon as it is back on.
param([Parameter(Mandatory = $true)][string]$User)
$ErrorActionPreference = 'Stop'

try {
  $Root   = Split-Path -Parent $PSScriptRoot
  $RunPs1 = Join-Path $PSScriptRoot 'run.ps1'

  # Same times and flags as the crontab on the Linux boxes (East Africa Time).
  $jobs = @(
    @{ Name = '0500 report';     Hour = 5;  Minute = 0;  Mode = 'report' },
    @{ Name = '0530 verify';     Hour = 5;  Minute = 30; Mode = 'verify' },
    @{ Name = '0600 catchup';    Hour = 6;  Minute = 0;  Mode = 'catchup0600' },
    @{ Name = '0655 catchup';    Hour = 6;  Minute = 55; Mode = 'catchup0655' },
    @{ Name = '1625 end of day'; Hour = 16; Minute = 25; Mode = 'eod' }
  )

  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

  foreach ($j in $jobs) {
    # Start from the next occurrence, so registering at 10:00 does not count
    # this morning's runs as missed and fire them all straight away.
    $at = [datetime]::Today.AddHours($j.Hour).AddMinutes($j.Minute)
    if ($at -le (Get-Date)) { $at = $at.AddDays(1) }

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Root `
      -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$RunPs1`" -Mode $($j.Mode)"
    $trigger = New-ScheduledTaskTrigger -Daily -At $at

    Register-ScheduledTask -TaskPath '\hocreport\' -TaskName $j.Name `
      -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
      -Description "hocreport: node index.js, mode $($j.Mode)" -Force | Out-Null
    Write-Host "Registered \hocreport\$($j.Name), first run $at"
  }
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
