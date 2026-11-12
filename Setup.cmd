@echo off
rem Double-click to set hocreport up on this PC. Needs internet; takes a few minutes.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\setup.ps1"
echo.
pause
