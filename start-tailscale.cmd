@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Quizzer requires Node.js 20 or newer.
  pause
  exit /b 1
)
node scripts\tailscale.mjs
if errorlevel 1 pause
