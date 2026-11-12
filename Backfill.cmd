@echo off
rem Double-click to fill in days the daily runs missed. Asks for the dates,
rem does a dry run first, and writes to the Sheets only after you say Y.
setlocal
echo Fill in days the daily runs missed.
echo Dates are YYYY-MM-DD, East Africa Time, and must be before today.
echo Give only the missed days: days that are already complete get their
echo figures replaced with the dashboards' current view.
echo.
set "FROM="
set "TO="
set /p "FROM=First missed day: "
set /p "TO=Last missed day:  "
if "%FROM%"=="" goto end
if "%TO%"=="" set "TO=%FROM%"

echo.
echo ===== Dry run: reading the dashboards, writing nothing =====
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\run.ps1" -Mode backfill -From "%FROM%" -To "%TO%" -Dry
if errorlevel 2 goto end
if errorlevel 1 (
  echo.
  echo Some dates failed in the dry run - see FAILED above. Writing now would
  echo skip those dates and write the rest; you can run them again later.
)

echo.
choice /c YN /m "Write these figures to the Sheets"
if errorlevel 2 goto end

echo.
echo ===== Writing =====
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\run.ps1" -Mode backfill -From "%FROM%" -To "%TO%"

:end
echo.
pause
