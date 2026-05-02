#!/usr/bin/env bash
# =============================================================================
# China HSR Simulation - One-shot Launch Script
# =============================================================================
# Installs dependencies, regenerates data when raw sources are present,
# runs the regression tests, builds the production bundle, then starts the
# static server at http://127.0.0.1:5174/.
#
# Usage:
#   ./run.sh                # full bootstrap + serve
#   ./run.sh --dev          # skip build, run Vite dev server with HMR
#   ./run.sh --skip-tests   # bootstrap + serve without the test suite
#   ./run.sh --rebuild      # force a clean install + rebuild
#   PORT=8080 ./run.sh      # override the default port (5174)
#   HOST=0.0.0.0 ./run.sh   # bind to all interfaces (default 127.0.0.1)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ---- Colours -----------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD="$(printf '\033[1m')"; RESET="$(printf '\033[0m')"
  BLUE="$(printf '\033[34m')"; GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"; RED="$(printf '\033[31m')"
else
  BOLD=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi
log()    { printf "%s[run]%s %s\n" "$BLUE" "$RESET" "$*"; }
ok()     { printf "%s[ok]%s  %s\n" "$GREEN" "$RESET" "$*"; }
warn()   { printf "%s[warn]%s %s\n" "$YELLOW" "$RESET" "$*"; }
fail()   { printf "%s[fail]%s %s\n" "$RED" "$RESET" "$*" >&2; exit 1; }

# ---- Flags -------------------------------------------------------------------
DEV_MODE=false
SKIP_TESTS=false
REBUILD=false
for arg in "$@"; do
  case "$arg" in
    --dev)        DEV_MODE=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    --rebuild)    REBUILD=true ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *) warn "Unknown flag '$arg' (ignored)" ;;
  esac
done

PORT="${PORT:-5174}"
HOST="${HOST:-127.0.0.1}"

# ---- Pre-flight: required tools ---------------------------------------------
log "${BOLD}China HSR Simulation${RESET} - bootstrap"
log "Working directory: $ROOT"

command -v node >/dev/null 2>&1 || fail "Node.js (>=18) is required. Install from https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  fail "Node.js >=18 required (detected v$(node -v)). Please upgrade."
fi
ok "Node.js $(node -v), npm $(npm -v)"

# ---- Optional: clean rebuild -------------------------------------------------
if [[ "$REBUILD" == true ]]; then
  log "Cleaning node_modules/ and dist/ for fresh install..."
  rm -rf node_modules dist
fi

# ---- Step 1: Install dependencies -------------------------------------------
if [[ ! -d node_modules ]]; then
  log "Installing npm dependencies..."
  npm install --no-fund --no-audit
  ok "Dependencies installed"
else
  ok "Dependencies already present (skip install). Use --rebuild to reinstall."
fi

# ---- Step 2: Data preparation (only if raw CSV/GeoJSON sources exist) -------
RAW_STATION_CSV="$ROOT/../China-rail-way-stations-data-main/src/station.csv"
RAW_LINE_CSV="$ROOT/../China-rail-way-stations-data-main/src/line.csv"
RAW_OSM_LINES="$ROOT/../hotosm_chn_railways_lines_geojson/hotosm_chn_railways_lines_geojson.geojson"

if [[ -f "$RAW_STATION_CSV" && -f "$RAW_LINE_CSV" && -f "$RAW_OSM_LINES" ]]; then
  log "Raw datasets detected; regenerating station/route/Mapbox database..."
  npm run prepare:data
  ok "Data artifacts written to public/"
elif [[ -f public/route-data.json && -f public/station-data.json ]]; then
  ok "Pre-built data artifacts found in public/ (skipping regeneration)"
else
  fail "No data artifacts found and raw CSV sources not available.
  Either commit the public/*.json files or add the upstream datasets at
  ../China-rail-way-stations-data-main/ and ../hotosm_chn_railways_*."
fi

# ---- Step 3: Tests -----------------------------------------------------------
if [[ "$SKIP_TESTS" == true ]]; then
  warn "Skipping tests (--skip-tests)"
else
  log "Running regression tests (booking, pricing, engine, data diversity)..."
  npm test
  ok "All tests passed"
fi

# ---- Step 4: Build or dev ----------------------------------------------------
if [[ "$DEV_MODE" == true ]]; then
  log "Starting Vite dev server with HMR on http://${HOST}:${PORT}/"
  log "Press Ctrl+C to stop."
  exec npx vite --host "$HOST" --port "$PORT" --strictPort
fi

if [[ ! -f dist/index.html || "$REBUILD" == true ]]; then
  log "Building production bundle..."
  npm run build
  ok "Build complete -> dist/"
else
  ok "Existing dist/ bundle reused (use --rebuild to refresh)"
fi

# ---- Step 5: Launch server ---------------------------------------------------
log "Launching static server..."
log "${BOLD}Open in browser:${RESET} http://${HOST}:${PORT}/"
log "Press Ctrl+C to stop."
HOST="$HOST" PORT="$PORT" exec node scripts/serve-static.cjs
