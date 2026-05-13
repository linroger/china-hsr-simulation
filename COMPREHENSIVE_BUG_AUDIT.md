# China HSR Simulation — Comprehensive Bug & Issue Audit

**Audited:** 2026-05-14  
**Scope:** Full stack — OceanBase integration, data pipeline, simulation engine, algorithms, frontend, build/config  
**Total Issues:** 100+ (Critical / High / Medium / Low)

---

## 1. Executive Summary

The simulation is architecturally sound and 24/24 tests pass, but it carries **significant production risks** across all layers:

- **Security:** plaintext database passwords, automatic empty-password injection, XSS in map popups, missing SSL/TLS
- **Reliability:** connection leaks, no retry logic, fire-and-forget ingest, stale train ID crashes, missing error boundaries
- **Performance:** per-batch DB commits, O(n²) string concat, unbounded array growth, excessive React re-renders
- **Correctness:** hardcoded 2026 calendar, leap-year blind date math, zero-distance pricing, silent data loss on missing coordinates
- **Data Quality:** CSV parser doesn't handle quoted fields, ~90km corridor deviation tolerance, node averaging drift in rail graph

---

## 2. OceanBase Integration (Python + Node Server)

| # | Severity | File | Issue |
|---|----------|------|-------|
| OB-1 | **CRITICAL** | `.env` | Real password `OceanBase11!!` stored in plaintext. Committed to git history (`.env` is tracked). |
| OB-2 | **CRITICAL** | `serve-static.cjs:145-146` | Auto-injects `--allow-empty-password` when `OB_PASSWORD` is missing on localhost. |
| OB-3 | **CRITICAL** | `serve-static.cjs:149,229` | Hardcodes OrbStack VM name `oceanbase-desktop` and `/opt/homebrew/bin/orb`. Breaks on non-macOS or renamed VMs. |
| OB-4 | **CRITICAL** | `serve-static.cjs:159-172,250-262` | Orb commands always pass `--allow-empty-password`, disabling auth inside the VM. |
| OB-5 | **CRITICAL** | `oceanbase_booking_ingest.py:75-109` | Connection never closed if `executemany` raises. Leaks DB connections on every failed batch. |
| OB-6 | **CRITICAL** | `oceanbase_booking_ingest.py:86-100` | `ON DUPLICATE KEY UPDATE` only updates 4 fields. Corrections to other columns are silently ignored. |
| OB-7 | **CRITICAL** | `oceanbase_booking_ingest.py:111-112` | Input NDJSON file is `unlink()`ed even if ingest partially failed. Data loss. |
| OB-8 | **CRITICAL** | `oceanbase_seed.py:337-369` | DB connection held open during long multiprocessing computation. May hit `wait_timeout`. |
| OB-9 | **CRITICAL** | `oceanbase_seed.py:341-353` | No `try/finally` around dimension load → connection leak on exception. |
| OB-10 | **CRITICAL** | `oceanbase_seed.py:1045-1051` | `bulk_execute` commits after **every** batch (~110 commits for 438k rows). |
| OB-11 | **CRITICAL** | `oceanbase_seed.py:1092-1117` | `query_table_counts` swallows **all** exceptions and returns `0`. Cannot distinguish "empty table" from "connection lost". |
| OB-12 | **HIGH** | `export_oceanbase_simulation_data.py:170-180` | `read_timeout=20` can abort large route queries mid-stream. |
| OB-13 | **HIGH** | `export_oceanbase_simulation_data.py:280-283` | **Entire route** silently dropped if one stop lacks coordinates. |
| OB-14 | **HIGH** | `export_oceanbase_simulation_data.py:373-374` | Duplicate `station_locations` silently de-duplicated (first wins). Wrong coordinate may be kept. |
| OB-15 | **HIGH** | `export_oceanbase_simulation_data.py:512-513` | Missing coordinates become `0.0` in seed DB (off the coast of Africa). |
| OB-16 | **HIGH** | `migrate_12306_to_oceanbase.py:744-782` | No all-or-nothing transaction for multi-table load. If table 7 of 8 fails, tables 1–6 are already committed. |
| OB-17 | **HIGH** | `migrate_12306_to_oceanbase.py:842-850` | Per-batch commits during bulk load (~46 commits for 226k rows). |
| OB-18 | **HIGH** | `serve-static.cjs:104-139` | No circuit breaker for failing OceanBase exports. Spawns a new Python process on **every** API request. |
| OB-19 | **HIGH** | `serve-static.cjs:122-126` | Cache TTL is only **60 seconds** for static route data. |
| OB-20 | **HIGH** | `serve-static.cjs:181-191` | O(n²) string concatenation for large stdout buffers. |
| OB-21 | **HIGH** | `serve-static.cjs:64-75` | O(n²) string concatenation for POST body (`body += chunk`). |
| OB-22 | **HIGH** | `serve-static.cjs:111-119` | Fallback response leaks internal Python error messages to the browser. |
| OB-23 | **HIGH** | `serve-static.cjs:216-225` | Fallback JSON file may be stale (never regenerated after a successful DB export). |
| OB-24 | **HIGH** | `oceanbase_booking_ingest.py:177` | `seats_json` column truncated to 500 chars → invalid JSON in DB. |
| OB-25 | **HIGH** | `oceanbase_booking_ingest.py:178-181` | `safe_float` / `safe_int` silently corrupt invalid data (return `0` on parse failure). |
| OB-26 | **MEDIUM** | `serve-static.cjs:86-90` | `fs.writeFileSync` blocks the event loop on large NDJSON batches. |
| OB-27 | **MEDIUM** | `serve-static.cjs:92-94,227-242` | `runIngestProcess` has no timeout, success check, or rate limiting on concurrent processes. |
| OB-28 | **MEDIUM** | `oceanbase_seed.py:1120-1168` | Holiday calendar hardcoded for **2026 only** (non-leap year day-of-year ranges). |
| OB-29 | **MEDIUM** | `oceanbase_seed.py:1294-1304` | `value()` / `number()` cannot distinguish `NULL` from `0`. |
| OB-30 | **LOW** | All Python files | No connection pooling anywhere. |
| OB-31 | **LOW** | All Python files | No retry logic for transient failures. |
| OB-32 | **LOW** | All Python files | No SSL/TLS configuration for DB connections. |

---

## 3. Data Pipeline (`scripts/prepare-data.cjs`)

| # | Severity | Line(s) | Issue |
|---|----------|---------|-------|
| DP-1 | **CRITICAL** | `parseCsv:1183-1196` | CSV parser is **naive split on commas**. Does **not** handle quoted fields containing commas or newlines. Will corrupt any CSV row with embedded commas. |
| DP-2 | **CRITICAL** | `buildRailNetwork:708-803` | Rail node averaging: `node.lng = (node.lng * refCount + lng) / (refCount + 1)`. If many vertices snap to the same 600m cell, the averaged node can drift **hundreds of meters** from any actual rail junction. |
| DP-3 | **HIGH** | `pickIntermediateStops:487-529` | Corridor width tolerance is enormous: `max(90 km, corridorWidth * 1.5)`. For a 1000km route, deviation up to **210 km** is allowed. Stations far from the actual rail line can be selected. |
| DP-4 | **HIGH** | `traceOverRailGraph:842-877` | Path rejection: `pathDistanceKm > directKm * 1.85 + 12`. Real rail lines in mountainous areas can easily exceed 1.85× the straight-line distance. Legitimate routes are rejected to fallback. |
| DP-5 | **HIGH** | `repairBigJumps:1068-1102` | `maxJumpDeg = 0.45°` (~50 km at China latitudes). Jumps of **49 km** are considered acceptable and only linearly interpolated, not flagged as errors. |
| DP-6 | **HIGH** | `deduplicateByOd:547-562` | Uses undirected frequency key (`sort().join('|')`) for directed OD pairs. Merges frequency of `A→B` and `B→A`, which are distinct services. |
| DP-7 | **HIGH** | `inferProvinceCity:1145-1181` | Nearest-neighbor inference within 100km can assign wrong province to stations near provincial borders. |
| DP-8 | **HIGH** | `capVertexCount:931-940` | Evenly spaces vertices when capping count. **Critical curvature points** (sharp turns, junctions) can be discarded because they don't land on the uniform step grid. |
| DP-9 | **MEDIUM** | `buildRailGeojson:664-700` | Stride simplification (`Math.ceil(coordinates.length / 80)`) arbitrarily drops vertices. Important junctions or curves may be skipped. |
| DP-10 | **MEDIUM** | `sampleRailCorridor:1000-1039` | `projection < -0.05 || projection > 1.05` filter and `perp > max(28, min(110, directKm * 0.32))` allows points up to **110 km** perpendicular from the chord. |
| DP-11 | **MEDIUM** | `macroRegion:624-634` | Regex-based province classification. Misses Taiwan (not listed) and may misclassify stations with empty/abbreviated province names. |
| DP-12 | **MEDIUM** | `mergeSegmentGeometries:1115-1124` | Merges segment geometries by coordinate equality (`===`). Uses `===` on arrays, which is **always false** for distinct array objects. Duplicates are only removed when the **same array reference** is reused, which never happens. Result: duplicate coordinates at segment boundaries. |
| DP-13 | **LOW** | `buildRoute:408-481` | `dwellMinutes` capped at 6/4/2 based on tier. Real HSR dwell times vary by train type and platform configuration. |

---

## 4. Simulation Engine (`src/simulation_core/SimulationEngine.js`)

| # | Severity | Line(s) | Issue |
|---|----------|---------|-------|
| SE-1 | **CRITICAL** | `loop:198-206` | `setTimeout(() => this.loop(), 1000 / 20)` is **fixed 50ms** regardless of how long `tick()` + `snapshot()` take. If processing exceeds 50ms (common with 6000 trains), the event loop piles up callbacks, causing runaway CPU and memory growth. |
| SE-2 | **CRITICAL** | `advanceServiceDay:239-253` | Creates **fresh train objects** every day. All existing bookings, ledger entries, and events from previous day are **discarded** (bookings array reset). The `this.bookings` array only retains global last-400, but per-train state is lost. |
| SE-3 | **CRITICAL** | `bookTrip:457-509` | Calls `getTrain(trainId)` after `computeQuote()`. If the service day advances **between quote and book** (rare but possible at day boundary), `trainId` is stale and `getTrain` **throws**, crashing the booking flow. |
| SE-4 | **CRITICAL** | `updateTrain:283-328` | Monotonic guard: `nextProgressKey + 1e-6 < previousProgressKey`. If floating-point drift causes `nextProgressKey` to be slightly less than `previousProgressKey`, the train **freezes forever** (returns without updating state). |
| SE-5 | **HIGH** | `processStation:374-401` | For every station stop, iterates **all train.bookings** (up to 1500). With 6000 trains and many stops per tick, this is **O(trains × bookings × stops)** — major CPU bottleneck. |
| SE-6 | **HIGH** | `snapshot:574-615` | `serialized = this.trains.map(serializeTrain)` creates a **massive intermediate array** (6000+ objects) every tick. `selectVisibleTrains` then sorts all active trains. This is the hottest path in the engine. |
| SE-7 | **HIGH** | `snapshot:574-615` | `activeTrains`, `scheduledTrains`, `completedTrains` are computed with **three separate `.filter()` passes** over the full array. Could be computed in one pass. |
| SE-8 | **HIGH** | `createBookingOptions:621-642` | Maps **all trains** to booking options on every dirty snapshot (6000+ objects). Most trains are not visible or bookable by the user. |
| SE-9 | **HIGH** | `monthDayToOrdinal:794-797` | Hardcoded non-leap-year month offsets. If `SERVICE_DAY_START_YEAR` is ever a leap year (e.g., 2028), all day-of-year calculations for March+ are off by one. |
| SE-10 | **HIGH** | `holidayWindow:772-783` | Day-of-year ranges are hardcoded for **2026** only. If the simulation start year changes, holiday windows shift incorrectly. |
| SE-11 | **HIGH** | `calendarState:721-770` | Uses `Date.UTC(2026, 0, 1 + dayIndex)`. If `yearDays > 365` or start year changes, leap-year logic is wrong. |
| SE-12 | **HIGH** | `weightedTrainChoice:1029-1042` | `load` factor uses `train.inventory.occupancyForSegment(train.currentSegmentIndex || 0)`. For `scheduled` trains, `currentSegmentIndex` is `0`, but the train has no meaningful load yet. Weights may be misleading. |
| SE-13 | **HIGH** | `prepareReturnLeg:330-359` | `train.segmentMinutes = (train.segmentMinutes || []).slice().reverse()`. If `segmentMinutes` is missing (shouldn't happen but defensive), it becomes an empty array and the return leg has zero-length segments. Train instantly completes. |
| SE-14 | **MEDIUM** | `tick:208-237` | `sellRealtimeDemand` filters `bookable` trains with `.filter()` every 6th tick. `bookable` includes trains with `departureMinute > nowMinutes - 20` — includes recently departed trains that are already running. Should probably be `> nowMinutes`. |
| SE-15 | **MEDIUM** | `tick:208-237` | `requestCount = Math.round(14 * demandMultiplier)` — on surge days this is ~22 requests. With 20 ticks/sec, that's 440 booking attempts/sec. High churn but acceptable. |
| SE-16 | **MEDIUM** | `cancelBooking:550-561` | `this.bookings` is capped at 400 entries. Cancellation of older bookings returns `false` with no explanation. User sees unexplained failure. |
| SE-17 | **MEDIUM** | `recordLedgerEntry:511-536` | `this.ledger` capped at 4000. If flush fails repeatedly, ledger wraps and **loses unflushed entries** permanently. |
| SE-18 | **MEDIUM** | `logEvent:569-572` | `Date.now()` used for event IDs. In a tight loop, collisions possible. `this.events.slice(0, 80)` truncates silently. |
| SE-19 | **MEDIUM** | `preloadTrainDemand:156-181` | `groupSizeFromRandom` can return sizes up to 6, but `canFitGroup` is checked in `allocate()`. If group size exceeds available seats, `allocate()` returns null. Preload loop silently skips. |
| SE-20 | **LOW** | `preloadDemandBatch:138-150` | Batch size is 120, but no yield to event loop between batches. In Node main thread this blocks. (In Web Worker it's less critical but still janky.) |
| SE-21 | **LOW** | `distanceBetween:992-998` | Falls back to `haversineKm` for missing segment distances. If segments have `distanceKm = 0`, it double-counts because `haversineKm` is called for each zero segment. |

---

## 5. Algorithms

### Seat Inventory (`src/algorithms/seatInventory.js`)

| # | Severity | Line(s) | Issue |
|---|----------|---------|-------|
| SI-1 | **HIGH** | `findAllocationGroup:165-187` | For `groupSize > rowCapacity`, returns `fallback.slice(0, groupSize)` immediately. `fallback` is populated in seat iteration order, **not** grouped by car. Large groups may be scattered across many cars. |
| SI-2 | **HIGH** | `releaseTicket:189-199` | Iterates **all 554 seats** to find one ticketId. O(n) per cancellation. With many cancellations, this is expensive. Should maintain a `ticketId → seatId` index. |
| SI-3 | **MEDIUM** | `availableSeats:111-118` | Calls `isSeatAvailable()` which re-validates interval bounds. Redundant validation (already called in outer scope). |
| SI-4 | **MEDIUM** | `availabilityCount:120-128` | Could early-exit if `groupSize` exceeds class capacity, but doesn't. |
| SI-5 | **LOW** | `createSeatMap:33-56` | Hardcoded 8-car layout. Does not support 16-car or variable-length consists. |

### Pricing (`src/algorithms/pricing.js`)

| # | Severity | Line(s) | Issue |
|---|----------|---------|-------|
| PR-1 | **HIGH** | `priceQuote:16-43` | Zero-distance trips produce `price: 0` because both `baseFare` and `bidPrice` are proportional to `distanceKm`. `roundToNearest(0, 5)` returns `0`. |
| PR-2 | **HIGH** | `reconcileDemandForecast:46-53` | Returns `round(...)` which can round to `0` if all multipliers are < 0.5. This zeroes out the demand forecast, making `loadFactor * forecast = 0` regardless of actual occupancy. |
| PR-3 | **MEDIUM** | `priceQuote:22` | `peak` multiplier uses `departureHour >= 7 && departureHour <= 9 || ...`. Missing parentheses around the OR condition. It evaluates as `(departureHour >= 7 && departureHour <= 9) || (departureHour >= 17 && departureHour <= 20)`. This is actually correct, but brittle to edits. |
| PR-4 | **MEDIUM** | `priceQuote:25` | `bidPrice` formula: `Math.pow(Math.max(0.03, loadFactor), 1.8)`. At `loadFactor = 0.03`, bid price is near zero. For empty trains, bid price is negligible. |
| PR-5 | **LOW** | `priceQuote:27` | `Math.max(0.8, surgeMultiplier)` means surge can only increase prices by 20% max relative to base? No, `surgeMultiplier` is applied to the whole `(baseFare + bidPrice) * ...` product. Actually fine. |

---

## 6. Frontend / React / Mapbox

| # | Severity | File:Line | Issue |
|---|----------|-----------|-------|
| FE-1 | **CRITICAL** | `HSRMap.jsx:133-141` | **XSS vulnerability**: `.setHTML()` constructs HTML from train properties (`p.code`, `p.current`, `p.next`) without escaping. If any property contains `<script>` or HTML, it executes. |
| FE-2 | **CRITICAL** | `App.jsx:22-34` | `fetchOptionalJson('/api/oceanbase-simulation-data')` is called unconditionally. If the server is down or the export script crashes, the UI silently falls back to static JSON after a long timeout. No loading state for the API call. |
| FE-3 | **HIGH** | `HSRMap.jsx:149-182` | Animation `useEffect` depends on `[ready, trains]`. Every trains update (every 150ms) triggers a new 190ms animation transition. Rapid updates cause animation queue churn. |
| FE-4 | **HIGH** | `HSRMap.jsx:271-279` | `isLargeRouteJump` threshold is `0.35°` (~39 km). Trains can teleport 38 km without triggering the snap guard. |
| FE-5 | **HIGH** | `BookingPanel.jsx:46` | `useEffect` dependency array includes `snapshot.stats.totalBookings`. This causes a **quote refresh on every single booking** across the entire network, creating excessive worker round-trips. |
| FE-6 | **HIGH** | `Dashboard.jsx:6` | `topLoads = trains.slice().sort(...)` runs on **every render** (every 150ms). O(n log n) sort of up to 1500 trains. |
| FE-7 | **HIGH** | `Dashboard.jsx:189-195` | `buildRevenueSeries` recomputes cumulative totals on every render. Should be memoized. |
| FE-8 | **HIGH** | `SimulationWorkerClient.js:42-46` | `terminate()` rejects pending promises but does **not** remove `onmessage` listener. If the worker sends a late message, it may call `resolve` on a dead promise. |
| FE-9 | **HIGH** | `SimulationWorkerClient.js:67-74` | `call()` has **no timeout**. If the worker crashes or hangs, the Promise never resolves. UI buttons stay in "Booking..." forever. |
| FE-10 | **MEDIUM** | `App.jsx:62-66` | Cleanup sets `cancelled = true` and calls `workerRef.current?.terminate()`, but doesn't await worker shutdown. Race condition if component remounts quickly. |
| FE-11 | **MEDIUM** | `App.jsx:192-198` | `mergeSnapshot` mutates the `bookingOptions` reference: `return { ...nextSnapshot, bookingOptions: previous.bookingOptions }`. If `previous` is mutated later, the merged snapshot becomes inconsistent. |
| FE-12 | **MEDIUM** | `HSRMap.jsx:22-44` | `mapboxgl.accessToken = PUBLIC_MAPBOX_TOKEN` is set globally. If token is invalid, Mapbox throws during mount. No retry or fallback to token-free view. |
| FE-13 | **MEDIUM** | `BookingPanel.jsx:91` | `key={stop.name}` is not unique if a station appears twice (shouldn't happen, but no guarantee). |
| FE-14 | **LOW** | `Dashboard.jsx:161` | `<meter>` HTML element has no `min`/`max`/`low`/`high`/`optimum` attributes. Accessibility tools report it as incomplete. |

---

## 7. Build, Config & Infrastructure

| # | Severity | File | Issue |
|---|----------|------|-------|
| BI-1 | **CRITICAL** | `.env` | Tracked in git (not in `.gitignore`). Contains plaintext DB password. |
| BI-2 | **HIGH** | `init.sh:25-29` | Uses `rg` (ripgrep) without checking if it's installed. Fails on systems without ripgrep. |
| BI-3 | **HIGH** | `serve-static.cjs:318-329` | Missing MIME types for `.woff2`, `.webp`, `.wasm`, `.mp4`, `.webm`. Browsers may refuse to load assets. |
| BI-4 | **MEDIUM** | `serve-static.cjs:52-61` | Static file serving uses `path.resolve(DIST, safePath)`. `safePath` strips leading slashes but doesn't prevent null-byte injection or directory traversal via unicode normalization. |
| BI-5 | **MEDIUM** | `package.json` | No `engines` field specifying minimum Node version. Code uses modern features (optional chaining, `??`) that fail on Node < 14. |
| BI-6 | **LOW** | `vite.config.js` | Default config. No build optimization for `mapbox-gl` (large bundle). No `rollupOptions` to split chunks. |

---

## 8. Test Gaps

All 24 tests pass, but the following critical paths have **zero coverage**:

| Gap | Severity | Why It Matters |
|-----|----------|----------------|
| Worker timeout / hang | **CRITICAL** | If worker crashes, UI hangs forever. No test covers this. |
| Day boundary booking race | **CRITICAL** | Booking a train exactly as `advanceServiceDay` fires should not crash. |
| Zero-distance pricing | **HIGH** | Produces ¥0 tickets. No test for `distanceKm = 0`. |
| Cancel old booking (>400 backlog) | **HIGH** | Returns `false` silently. No test. |
| Map XSS payload | **HIGH** | `p.code = '<img src=x onerror=alert(1)>'` would execute. No sanitization test. |
| Connection leak on failure | **HIGH** | Python scripts don't close connections on exception. No test for failure paths. |
| Stale fallback JSON | **MEDIUM** | Fallback file may be months old. No freshness check. |
| CSV quoted-field parsing | **MEDIUM** | Parser breaks on commas inside quotes. No test with complex CSV. |
| Large group allocation scattering | **MEDIUM** | Groups of 6 may end up in 6 different cars. No assertion on car contiguity. |

---

## 9. Quick-Fix Priority Matrix

| Priority | Fix | Files | Est. Effort |
|----------|-----|-------|-------------|
| **P0** | Remove `.env` from git, rotate password, use env-only injection | `.env`, `.gitignore` | 5 min |
| **P0** | Remove auto `--allow-empty-password` injection | `serve-static.cjs` | 5 min |
| **P0** | Escape HTML in Mapbox popup | `HSRMap.jsx` | 5 min |
| **P0** | Guard `getTrain()` against stale IDs | `SimulationEngine.js` | 10 min |
| **P0** | Add timeout to worker `call()` | `SimulationWorkerClient.js` | 10 min |
| **P1** | Cap `loop()` callback scheduling to actual elapsed time | `SimulationEngine.js` | 15 min |
| **P1** | Memoize `topLoads` and `revenueSeries` in Dashboard | `Dashboard.jsx` | 10 min |
| **P1** | Add `try/finally` + connection pool to Python scripts | All `.py` | 30 min |
| **P1** | Replace O(n²) string concat with `Buffer.concat` / arrays | `serve-static.cjs` | 15 min |
| **P1** | Fix CSV parser to handle quoted fields | `prepare-data.cjs` | 30 min |
| **P2** | Batch commits (every N batches, not every batch) | `oceanbase_seed.py`, `oceanbase_booking_ingest.py` | 20 min |
| **P2** | Add circuit breaker to OceanBase export | `serve-static.cjs` | 20 min |
| **P2** | Add `ticketId → seat` index for fast cancellation | `seatInventory.js` | 15 min |
| **P2** | Lower `isLargeRouteJump` threshold to `0.08°` (~9 km) | `HSRMap.jsx` | 5 min |
| **P3** | Make holiday calendar year-aware / leap-year safe | `SimulationEngine.js` | 30 min |
| **P3** | Add booking state preservation across service days | `SimulationEngine.js` | 2 hrs |
| **P3** | Validate `mergeSegmentGeometries` deduplication | `prepare-data.cjs` | 15 min |

---

*End of audit. This file should be updated as fixes are applied.*
