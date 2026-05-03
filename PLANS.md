# PLANS.md

## 2026-05-03 Year-Long OceanBase Simulation Slice

The current app already runs a detailed 24-hour Jan 1 service day in a browser Web Worker. The next reliable slice is to add a full-year planning and persistence layer without trying to keep every train, passenger, and seat interval in browser memory at once.

### Goals

1. Generate a 365-day China HSR service plan from the existing route database with no cumulative cap on trains, passengers, or revenue.
2. Persist annual route-day aggregates into the local OceanBase `chinahsr` database using MySQL-compatible access and bulk inserts.
3. Use CPU multiprocessing for the heavy annual generation step, with worker count configurable for high-core Apple Silicon machines.
4. Surface the latest OceanBase-backed annual run in the React dashboard so the user can see annual trains, passengers, revenue, surge days, worker count, and table row counts.
5. Keep the browser simulation performant by preserving detailed seat-level inventory for the rolling active day while annual totals live in OceanBase aggregates.

### Design

- Add `scripts/oceanbase_seed.py`.
- Read `public/station-data.json` and `public/route-data.json`.
- Create OceanBase tables for stations, routes, route stops, route segments, simulation runs, and daily route service aggregates.
- Generate route-day aggregate rows in multiprocessing chunks for `2026-01-01` through `2026-12-31`.
- Bulk upsert all generated rows via PyMySQL. Credentials MUST come from `OB_HOST`, `OB_PORT`, `OB_USER`, `OB_PASSWORD`, and `OB_DATABASE`; no password is committed.
- Write a public `oceanbase-yearly-summary.json` snapshot after a successful database load so the static frontend can render the latest run without embedding database credentials in the browser.
- Add dashboard cards and tests for the yearly summary contract.

### Verification

1. Verify local OceanBase connection to `chinahsr`.
2. Run the OceanBase seed script against the local tenant.
3. Query row counts from OceanBase.
4. Run `npm test`, `npm run build`, `./init.sh`, and scans for local database-password leakage plus Mapbox secret-token leakage.
5. Reload or smoke-check `http://127.0.0.1:5174/` after rebuilding.

### GPU Note

Mapbox rendering already uses GPU-backed WebGL. The compute-heavy part of this slice is branchy seat/demand/service planning plus database I/O, which maps better to CPU multiprocessing than GPU kernels. The implementation will expose hardware/concurrency metadata and keep the WebGL map path GPU-backed; WebGPU compute can be added later only if a numeric kernel emerges that is large enough and regular enough to justify transfer overhead.
