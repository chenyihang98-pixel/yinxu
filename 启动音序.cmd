@echo off
cd /d "%~dp0"
if exist "release\Muse-BGM-0.2.0-Windows.exe" (
  start "" "release\Muse-BGM-0.2.0-Windows.exe"
) else (
  echo Please run npm run dist first, or use npm run desktop.
  pause
)
