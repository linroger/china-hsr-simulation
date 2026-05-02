#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "[init] China HSR Simulation"
echo "[init] working directory: $ROOT"

if [ ! -d node_modules ]; then
  echo "[init] installing npm dependencies..."
  npm install
fi

echo "[init] preparing station, route, and map data..."
npm run prepare:data

echo "[init] running booking/pricing tests..."
npm test

echo "[init] building production bundle..."
npm run build

echo "[init] scanning for Mapbox secret tokens..."
if rg "sk\\.ey" . >/tmp/china_hsr_secret_scan.txt; then
  cat /tmp/china_hsr_secret_scan.txt
  echo "[init] ERROR: secret-looking Mapbox token found in project files." >&2
  exit 1
fi

echo "[init] complete. Start the stable local app server with: npm run serve"
