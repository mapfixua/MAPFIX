@echo off
REM Windows launcher — bypasses PowerShell npm.ps1 ExecutionPolicy block.
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install from https://nodejs.org/
  exit /b 1
)

REM Prefer npm.cmd over npm.ps1 (avoids PSSecurityException)
where npm.cmd >nul 2>&1
if not errorlevel 1 (
  call npm.cmd start
  exit /b %ERRORLEVEL%
)

node scripts\free-port.js
node server.js
