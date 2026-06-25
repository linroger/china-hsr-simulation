# China HSR Simulation — Execution Plan (2026-06-16)

Optimization / enhancement / bug-fix pass. Findings were produced by an 8-dimension
parallel code audit (engine-correctness, algorithms, perf, frontend-react,
server-python, data-pipeline, docs-readme, build-tests) and each finding was
adversarially re-verified against the source. 49 reviewed → 46 confirmed/uncertain
→ 3 rejected. This plan also covers the requested **live demo**, **video/image
README rendering**, and **doc-accuracy** work.

Baseline at start: `npm test` 30/30 green; `npm run build` clean but main chunk
**1,941 KB**; `npm run perf` init 6.0s / **preload 144s** / snapshot p50 12.7ms,
max 1331ms / tick p95 88ms.

Legend: ✅ done · ▶ in progress · ☐ todo · ⏭ deferred (with reason)

---

## A. Live demo (GitHub Pages) — user request
- ✅ **A1** Vite `base` is now configurable (`BASE_PATH` env, default `/`) so the
  same bundle works at root (local/server) and under `/china-hsr-simulation/` (Pages). *(fixes audit #3, #45)*
- ✅ **A2** All runtime fetches routed through `withBase()` (`src/basePath.js`):
  `station-data.json`, `route-data.json`, `api/oceanbase-simulation-data`,
  `oceanbase-yearly-summary.json`, `ingest-bookings`. *(fixes audit #3)*
- ✅ **A3** Map engine loaded via dynamic `import()` → mapbox-gl/maplibre-gl split into
  their own chunks; **main entry chunk 1,941 KB → 210 KB (67 KB gzip)**. *(fixes audit #2, #16, #27)*
- ✅ **A4** Tokenless fallback: when no `pk.` token, HSRMap loads MapLibre GL + a free
  CARTO dark basemap, so the live demo renders for everyone.
- ✅ **A5** In-app rail + station GeoJSON layers (from committed `hsr-rails.geojson` /
  `hsr-stations.geojson`) so the network shows on ANY style, not just a private
  custom Mapbox style. Station tiers styled (national/regional/local). *(fixes audit #10)*
- ✅ **A6** Map error handling made non-fatal after first load (a single failed tile/glyph
  no longer blanks the map).
- ☐ **A7** GitHub Actions workflow to build + deploy Pages; `VITE_MAPBOX_TOKEN` stored as
  an Actions secret (public token, not committed). Set repo `homepageUrl` + description.

## B. High-severity bug fixes
- ☐ **B1 (#1)** `advanceServiceDay` double-books demand onto retained trains every day
  rollover (`preloadCursor` reset to 0). Fix: `this.preloadCursor = retained.length`.
- ☐ **B2 (#4)** `export_oceanbase_simulation_data.py` UnboundLocalError: `route_code`
  used at line 459 before assignment at 461. Fix: move assignment above the
  coordinate-correction log.
- ☐ **B3 (#5)** `serve-static.cjs` static stream has no `error` handler — a mid-read
  failure crashes the server. Fix: attach `stream.on('error', …)`.

## C. Performance
- ✅ **C1 (#2)** mapbox-gl out of main bundle (see A3).
- ☐ **C2 (#7)** `findAllocationGroup` rebuilds car/row Maps over all 554 seats on every
  allocation — dominates the 144s preload. Fix: O(1)-map fast path for groupSize 1, and
  early-exit + lazy byCar for groups. (Primary preload speedup.)
- ☐ **C3 (#8)** `createBookingOptions()` rebuilt + spread per non-completed train on every
  full snapshot (snapshot 1331ms spikes). Fix: cache + rebuild only when `bookingOptionsDirty`.
- ☐ **C4 (#28)** `networkSummaryFromTrains` scans all ~6000 trains every 5 ticks. Fix:
  throttle to every ~12 ticks (aggregates change slowly).
- ☐ **C5 (#19)** `perf-probe` has no thresholds / not a gate. Fix: add coarse upper-bound
  asserts so the 144s preload regression is caught.
- ☐ **C6 (#31)** Booking triggers two full snapshots + bypasses delta merge. Fix: rely on
  the worker's `booking` snapshot via `onSnapshot`.

## D. Medium correctness / robustness
- ☐ **D1 (#6)** `bookingVelocity` incremented before the `canBook` check → rejected
  attempts inflate prices. Fix: move increment after successful allocation.
- ☐ **D2 (#9)** No React error boundary → any render throw white-screens the app. Fix:
  add `ErrorBoundary` around the workspace.
- ☐ **D3 (#17)** `cancelBooking` decrements revenue but not `totalPassengers`/`totalBookings`.
  Fix: reverse all three counters; add regression test.
- ☐ **D4 (#11)** `capVertexCount` curvature scoring reads `.lng/.lat` on `[lng,lat]`
  arrays → every score 0 (dead code). Fix: positional indexing.
- ☐ **D5 (#12)** `findNearestNode` early-break returns a sub-optimal rail node. Fix:
  finish the current/next ring before breaking.
- ☐ **D6 (#30)** Dashboard scenario message never clears. Fix: auto-clear via effect timeout.
- ☐ **D7 (#32)** `bookings.seats_json` DDL drift (VARCHAR(512) seed vs TEXT ingest). Fix: TEXT both.

## E. Low-severity / hardening
- ☐ **E1 (#21)** Per-train booking cap (`slice(-1500)`) drops bookings still holding seat
  intervals → phantom inventory. Fix: release inventory for dropped bookings.
- ☐ **E2 (#22)** Event IDs use `Date.now()` → breaks seeded reproducibility. Fix:
  deterministic `evt-${counter}`.
- ☐ **E3 (#23,#24)** `priceQuote` propagates NaN / accepts negative distance silently.
  Fix: validate finite/positive inputs, fail fast.
- ☐ **E4 (#25)** `findAllocationGroup` step-2 comment inaccurate. Fix: reword.
- ☐ **E5 (#18)** `propagateDelay` cascade untested. Fix: add scenario test.
- ☐ **E6 (#46)** Demand-surge scenario test never asserts expiry. Fix: extend test.

## F. Documentation accuracy (doc-drift) — also user request ("fix video links")
- ☐ **F1 (#42)** Video links are plain markdown → no inline player on GitHub. Fix: upload
  clips as GitHub release assets and embed the rendering URLs; link Screenshots images.
- ☐ **F2 (#13)** Snapshot interval 200ms/5Hz (not 100ms/10Hz) — ~7 spots each README.
- ☐ **F3 (#14,#20)** Snapshot/feature train cap is 800 (not 1,500).
- ☐ **F4 (#38)** Test count is 30 (not 25) — badge, prose, sample output, trees.
- ☐ **F5 (#36)** Route count is 1,800 (not 1,200); rail-traced 83.7% (not 82.8%); recompute
  derived figures (OceanBase row count 657,000).
- ☐ **F6 (#40,#41,#44)** LoC drift: engine ~1,650 (not ~1,300); prepare-data ~1,540 (not 484);
  serve-static ~450 (not ~370).
- ☐ **F7 (#15)** OSM payload caps row (12,000 features / 1.4M vertices, not 8,000/820k).
- ☐ **F8 (#39)** `scenarios.test.mjs` missing from the test/structure listings.
- ☐ **F9 (#43)** §5.5 says ≥50% rail-matched but the test asserts ≥85%.
- ☐ **F10** Add a "Live demo" link + badge near the top of both READMEs.

## G. Deferred (out of scope / low value / high risk for this pass)
- ⏭ **#26** silent-quote availability approximation — intentional speed/accuracy tradeoff.
- ⏭ **#29** memoize HSRMap/Dashboard re-renders — uncertain; current re-renders drive the
  required animation; risk > reward without a restructure.
- ⏭ **#33** export cache key — only matters if params become request-derived (a comment suffices).
- ⏭ **#34,#35** ETL stat double-count / repairBigJumps threshold — only affect data
  *regeneration*; committed data passes all geometry tests. Note for a future regen pass.
- ⏭ **#37** vendor source CSVs for a fully reproducible pipeline — large; pre-generated JSON
  is committed and sufficient. Tracked as future work.

---

### Verification gates per change
`npm test` (must stay ≥30 green, with new tests added), `npm run build` (clean),
`npm run perf` (preload + snapshot must improve, tick within budget), and a live
Chrome smoke of the deployed Pages site (map renders, dashboard/booking work, README
videos play inline).
