@echo off
REM =============================================================================
REM China HSR Simulation - Windows launch script
REM Run with:  run.cmd
REM =============================================================================
setlocal enableextensions enabledelayedexpansion

set ROOT=%~dp0
cd /d "%ROOT%"

if "%PORT%"=="" set PORT=5174
if "%HOST%"=="" set HOST=127.0.0.1

echo [run] China HSR Simulation - bootstrap
echo [run] Working directory: %ROOT%

where node >nul 2>&1
if errorlevel 1 (
  echo [fail] Node.js ^>=18 is required. Install from https://nodejs.org/
  exit /b 1
)

if not exist node_modules (
  echo [run] Installing npm dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 exit /b 1
)

if exist "%ROOT%..\China-rail-way-stations-data-main\src\station.csv" (
  echo [run] Raw datasets detected; regenerating data...
  call npm run prepare:data
) else if exist public\route-data.json (
  echo [ok]  Pre-built data artifacts found in public\
) else (
  echo [fail] No data artifacts and no raw CSV sources.
  exit /b 1
)

if /I not "%~1"=="--skip-tests" (
  echo [run] Running regression tests...
  call npm test
  if errorlevel 1 exit /b 1
)

if /I "%~1"=="--dev" (
  echo [run] Starting Vite dev server on http://%HOST%:%PORT%/
  call npx vite --host %HOST% --port %PORT% --strictPort
  exit /b 0
)

if not exist dist\index.html (
  echo [run] Building production bundle...
  call npm run build
  if errorlevel 1 exit /b 1
)

echo [run] Launching static server at http://%HOST%:%PORT%/
node scripts\serve-static.cjs
endlocal
