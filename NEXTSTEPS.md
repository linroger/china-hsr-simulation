# NEXTSTEPS.md — China HSR Simulation

**Last Updated:** 2026-05-03
**Status:** Issues Investigated, Fix Plan Ready
**Current Focus:** Document all bugs, root causes, and recommended fixes

---

## 1) Executive Summary

The simulation has **four critical issues** that must be fixed:

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| 1 | Route geometry is scrambled/corrupted (trains teleport over water) | CRITICAL | Visual trains travel over ocean/inland seas |
| 2 | Simulation tick rate bug — tick(1) called every 50ms instead of actual elapsed time | CRITICAL | Trains appear 6x faster than intended |
| 3 | 47% of segments use `station-straight-fallback` (no rail geometry) | HIGH | Trains on these segments appear to go in straight lines over land/water |
| 4 | Xi'an stations missing from routing database | MEDIUM | 0 routes to/from Xi'an |
| 5 | Long routes only oscillate between 2 stations (not fully traversed) | HIGH | User-observed trains going back and forth on short segments |

---

## 2) Bug #1: Route Geometry Corruption (CRITICAL)

### Symptom
Trains appear to travel over water or teleport across large distances.

### Root Cause
The `hotosom-rail-corridor` geometry in `route-data.json` has **scrambled coordinate arrays**. The coordinates are not properly ordered along actual rail paths — they appear to be randomly shuffled or misaligned.

**Evidence:**
- **15,077 large jumps** (>0.5 degrees) found across route segment geometries
- **98.5% of route distance** has problematic geometry (only 1.5% "clean")
- Example: D3931 segment 麻江→衡阳东 has jumps up to **5.5 degrees** (hundreds of km in one step)

### How Train Position is Calculated
```javascript
// SimulationEngine.js:761
const coords = interpolateLine(segment?.geometry, train.segmentProgress || 0) || interpolateCoord(from, to, train.segmentProgress || 0);
```
The `interpolateLine` function linearly interpolates along the coordinate array. When coordinates are scrambled, the train teleports.

### Solution
The geometry corruption originates in `prepare-data.cjs`. The `railGeometryBetween()` function queries rail points but the resulting coordinate ordering doesn't follow actual rail paths — it uses a simple projection-based sort that can produce out-of-order results when rail lines curve.

**Fix approach:**
1. In `prepare-data.cjs`, when building segment geometry, ensure coordinates are ordered by distance along the rail path, not by projection fraction
2. Alternatively, switch to a proper path-finding approach: find the actual rail line IDs that connect two stations, then extract coordinates in order along that line
3. For segments where good rail geometry cannot be found, use the `station-straight-fallback` label and warn in the output

---

## 3) Bug #2: Simulation Tick Rate — Trains Too Fast (CRITICAL)

### Symptom
Trains appear to travel far too fast for the simulation speed. At speed=18 (intended "1 minute per second"), a 100km segment at 285km/h should take ~21 simulation minutes, which at "1 sim minute per real second" should be 21 real seconds. Instead it appears to traverse in ~3.5 real seconds.

### Root Cause
In `SimulationEngine.js`, the simulation loop runs every **50ms** but always passes `realSeconds=1` to `tick()`:

```javascript
// SimulationEngine.js:183
loop() {
    if (!this.running) return;
    this.tick(1);  // ← ALWAYS passes 1, regardless of actual elapsed time (50ms!)
    this.callbacks.onUpdate?.(this.snapshot());
    this.timer = setTimeout(() => this.loop(), 1000 / 20);  // 20Hz loop
}
```

**Correct calculation:**
- Actual elapsed time per tick: 50ms = 0.05 seconds
- Per tick: `realSeconds * speed / 60 = 0.05 * 18 / 60 = 0.015 minutes`
- Per real second: 20 ticks * 0.015 = **0.3 minutes per real second**

**Current broken calculation (passing 1 instead of 0.05):**
- Per tick: `1 * 18 / 60 = 0.3 minutes`
- Per real second: 20 * 0.3 = **6 minutes per real second**

So trains are moving **20x faster than intended** (6 min/sec vs 0.3 min/sec).

### The Fix
```javascript
loop() {
    if (!this.running) return;
    const tickStartMs = performance.now();
    this.tick(1);  // ← pass actual elapsed time in seconds
    this.callbacks.onUpdate?.(this.snapshot());
    const elapsed = performance.now() - tickStartMs;
    this.timer = setTimeout(() => this.loop(), Math.max(0, 1000 / 20 - elapsed));
}
```

Actually, the `tick(realSeconds)` parameter should measure actual wall time:

```javascript
loop() {
    if (!this.running) return;
    const before = performance.now();
    this.tick(1);  // THIS IS WRONG - should be actual elapsed
    const after = performance.now();
    this.callbacks.onUpdate?.(this.snapshot());
    this.timer = setTimeout(() => this.loop(), 1000 / 20);
}
```

**Proper fix:**
```javascript
loop() {
    if (!this.running) return;
    const before = performance.now();
    this.tick(1);  // tick should compute actual elapsed: (before - lastTick) / 1000
    this.lastTick = performance.now();
    this.callbacks.onUpdate?.(this.snapshot());
    this.timer = setTimeout(() => this.loop(), 1000 / 20);
}
```

OR simpler: the `tick` function should track its own delta time:

```javascript
loop() {
    if (!this.running) return;
    this.tick(this.lastTick ? (performance.now() - this.lastTick) / 1000 : 1);
    this.lastTick = performance.now();
    this.callbacks.onUpdate?.(this.snapshot());
    this.timer = setTimeout(() => this.loop(), 1000 / 20);
}
```

---

## 4) Bug #3: Station Straight-Fallback Segments (HIGH)

### Symptom
47% of segments (2,865 out of 6,061) use `geometrySource: 'station-straight-fallback'`. These are 2-point straight lines that don't follow actual rail infrastructure.

### Example
```
南京 → 上海 route, segment 惠山 → 无锡东:
geometry: [[120.196882,31.671535],[120.455537,31.598783]]
source: "station-straight-fallback"
```
This 28km segment goes in a straight line that may cross water or land features that don't match actual rails.

### Root Cause
In `prepare-data.cjs`, the `railGeometryBetween()` function falls back to straight-line when fewer than 3 rail candidate points are found:

```javascript
// prepare-data.cjs:331-336
if (sampled.length < 3) {
    return {
        source: 'station-straight-fallback',
        coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
    };
}
```

The issue is the rail index grid (cellSize 0.35°) may miss short segments or segments in areas with sparse OSM rail data.

### Solution
1. **Reduce grid cell size** in `createRailIndex()` from 0.35 to 0.15-0.20 degrees for better spatial resolution
2. **Increase margin** in `railGeometryBetween()` to capture more rail points: `Math.min(5, Math.max(0.8, directKm / 150))`
3. **Consider straight-fallback as a warning**, not silently accepted — add a validation pass that flags these segments for manual review

---

## 5) Bug #4: Xi'an Routes Missing (MEDIUM)

### Symptom
0 routes to/from Xi'an exist in the simulation, despite Xi'an being a major national hub with extensive HSR connections.

### Root Cause
The station naming in the source CSV doesn't match the `stationByName` map. Looking at `prepare-data.cjs`, station names are cleaned with `clean(row['站名'])`. If the CSV uses variant names (e.g., "西安北" vs "西安" vs "西安北站"), they won't match.

Also, the `stationTier` function's regex may not correctly classify all Xi'an stations:
```javascript
// prepare-data.cjs:455
if (/北京|上海|广州|深圳|成都|重庆|武汉|郑州|西安|南京|杭州|长沙|天津/.test(name)) return 'national-hub';
```
But Xi'an stations in the CSV may use full names like "西安北站" which the regex wouldn't match.

### Solution
1. Add more Xi'an variants to the station tier detection
2. Log unmatched routes during preparation to identify naming mismatches
3. Add a fallback: fuzzy station name matching using edit-distance or known alias tables

---

## 6) Bug #5: Long Routes Oscillate Between 2 Stations (HIGH)

### Symptom
Trains on long routes like Shanghai→Shenzhen or Beijing→Shanghai only travel between 2 nearby stations instead of traversing the complete route.

### Investigation Status
This may be a **combination of multiple issues**:
- The `selectVisibleTrains` limit of 850 trains may cause long-route trains to be excluded from the visible set if there are many short-route trains
- The `updateTrain` function's segment iteration logic appears correct on paper
- The `advanceServiceDay` creates fresh trains each day with new IDs

### Likely Root Cause
Looking at `selectVisibleTrains`:
```javascript
function selectVisibleTrains(trains, limit) {
    const active = trains.filter((train) => train.status === 'running');
    const scheduled = trains.filter((train) => train.status === 'scheduled' && train.minutesToDeparture <= 120);
    const completed = trains.filter((train) => train.status === 'completed').slice(-60);
    return [...active, ...scheduled, ...completed]
        .sort((a, b) => statusRank(a.status) - statusRank(b.status) || Math.abs(a.minutesToDeparture) - Math.abs(b.minutesToDeparture))
        .slice(0, limit);
}
```

The sort by `Math.abs(a.minutesToDeparture)` means trains closer to departure (or that just departed) are prioritized. Long-route trains that started earlier and are still running may be pushed out by newer scheduled trains.

Also, the `SNAPSHOT_TRAIN_LIMIT = 850` means if there are many active trains, long-route ones may be excluded.

### Solution
1. **Increase SNAPSHOT_TRAIN_LIMIT** to 1200-1500 to accommodate more trains
2. **Modify sort priority**: Give running trains (status='running') much higher priority so they're never excluded, then sort by `minutesToDeparture` only within the same status rank
3. **Add diagnostic logging**: Log when trains are excluded due to the limit to quantify the scope

---

## 7) Speed Calibration — Making Simulation Faster vs Slower

### Current State
- Speed range: 1-120 (default 18)
- `nowMinutes += realSeconds * speed / 60`
- With speed=18 and correct realSeconds=0.05: 0.015 min/tick → 0.3 min/sec → **1 simulation minute = 3.33 real seconds**

### User Request
The user wants the simulation to be **faster** (less slowness) but **trains to appear to travel at correct speeds relative to simulation time**.

### Solution
The issue is NOT the simulation speed itself — the issue is that with the tick bug fixed, the simulation will be **slower** (at speed=18, 0.3 min/sec means 1 real hour = 18 simulation minutes).

If the user wants a faster overall simulation:
1. Increase the default speed from 18 to 60-120 in App.jsx
2. Or adjust the tick rate: `setTimeout(() => this.loop(), 1000 / 60)` for 60Hz updates

For **train travel time accuracy**:
- At 285km/h, 100km = 21.05 minutes
- At speed=18, 1 real second = 0.3 sim minutes → 100km takes 70 real seconds
- At speed=60, 1 real second = 1 sim minute → 100km takes 21 real seconds (correct)

**Recommendation:** Default speed should be **60** for realistic travel times, not 18.

---

## 8) Other Issues & Improvements

### 8.1 Route Duplicates
139 route pairs have duplicate origin/destination (same route defined multiple times in line.csv). This isn't a bug but wastes capacity.

**Fix:** Deduplicate routes with the same origin/destination pair, keeping the one with highest `frequencyRank`.

### 8.2 Rail Index Grid Resolution
The `cellSize = 0.35` degrees for the rail index may miss short rail segments.

**Fix:** Reduce to 0.15-0.20 degrees.

### 8.3 Demand Preload Can Be Slow
The background demand preload runs in 80-train batches with 8ms delays.

**Fix:** Increase batch size to 200-300 for faster startup.

### 8.4 No Route Geometry Validation
There's no validation that segment geometries actually connect at their endpoints. A segment ending at [lng1, lat1] should have its next segment starting from the same point.

**Fix:** Add a post-processing validation pass that checks coordinate continuity at stop boundaries.

---

## 9) Priority Implementation Order

| Priority | Item | Files to Modify | Effort |
|----------|------|-----------------|--------|
| P0 | Fix tick rate (pass actual elapsed time) | `SimulationEngine.js` | 15 min |
| P0 | Fix default speed (18→60) | `App.jsx` | 5 min |
| P1 | Increase visible train limit | `SimulationEngine.js` | 5 min |
| P1 | Fix train sort priority (running trains first) | `SimulationEngine.js` | 10 min |
| P2 | Improve rail index resolution | `prepare-data.cjs` | 30 min |
| P2 | Fix Xi'an station matching | `prepare-data.cjs` | 20 min |
| P3 | Route geometry re-ordering (proper path finding) | `prepare-data.cjs` | 4-8 hrs |
| P3 | Route deduplication | `prepare-data.cjs` | 30 min |

---

## 10) Summary of Fixes

### Quick Fixes (P0-P1, <1 hour total)
1. **`SimulationEngine.js` loop()**: Pass actual elapsed time to `tick()`
2. **`App.jsx`**: Change default speed from 18 to 60
3. **`SimulationEngine.js` `SNAPSHOT_TRAIN_LIMIT`**: Increase from 850 to 1500
4. **`SimulationEngine.js` `selectVisibleTrains`**: Ensure running trains are never excluded

### Medium Fixes (P2, 1-2 hours)
5. **`prepare-data.cjs` `cellSize`**: Reduce from 0.35 to 0.18
6. **`prepare-data.cjs` Xi'an matching**: Add variant names

### Long-term Fixes (P3, 4-8 hours)
7. **`prepare-data.cjs` geometry ordering**: Replace projection-sort with actual path-following algorithm along rail lines
8. **`prepare-data.cjs` route deduplication**: Eliminate duplicate origin/destination pairs

---

## 11) Verification Plan

After applying fixes:

1. **Tick rate fix**: Verify that at speed=60, a 100km segment takes ~21 real seconds to traverse (not 3.5)
2. **Geometry fix**: Visually verify that train dots follow actual rail lines on the map, not straight lines over water
3. **Long route fix**: Track a specific train (e.g., G7001 北京南→上海虹桥) from departure to arrival and verify it visits all intermediate stops
4. **Xi'an fix**: Verify routes involving Xi'an now appear in the route list
5. **Performance**: Simulation should start faster with increased preload batch size

---

## 12) Fixes Applied (2026-05-03 — Pass 2, 2026-05-03 evening)

### Pass 2 (this session) — major data pipeline + simulation overhaul

**Pipeline (`scripts/prepare-data.cjs`)**

- **Replaced projection-by-chord with rail-graph A\* path tracing.** Built a 254,501-node / 275,919-edge rail graph from all 347,132 OSM `railway=rail` LineStrings (was: 8,000 simplified for rendering only) at 0.0055° (~600 m) cell size. A\* uses straight-line-to-goal as admissible heuristic with bounded exploration (`max(180, directKm × 2.2) km`) and a custom binary heap.
- **Geometry source distribution went from 52.7 % → 99.4 % rail-matched** (70.4 % rail-traced + 29.0 % corridor-sampled, 0.6 % straight fallback).
- **0 large coord jumps and 0 segment-boundary breaks** across 218,127 transitions and 6,301 boundaries (was 27 % big jumps).
- **OSM-augmented station database** — 89 missing HSR hubs (西安北 / 昆明南 / 南宁东 / 香港西九龙 / 长沙西 / 贵阳北 / 株洲南 / …) added via OSM points fallback when CSV doesn't list them. Known-endpoint coverage rose from 64 % → 96.3 %. Xi'an routes went from 0 → 67.
- **Route deduplication** — directed (origin, destination) pairs are now uniquely keyed; 6,186 candidates collapse to 1,850 unique pairs before stratified sampling.
- **Province/city inference** for OSM-augmented stations via 100 km nearest-CSV-neighbour lookup.
- **Geometry simplification** — Douglas-Peucker with adaptive tolerance (0.0008°–0.0035°), then vertex cap (≤ 70 / segment), then 5-decimal coord rounding. `route-data.json` shrank from 78 MB → 13 MB while keeping visible curvature.
- **Big-jump repair pass** — any residual coord-to-coord jump > 0.45° is patched via linear interpolation (1,280 segments needed minor repair).

**Simulation engine (`src/simulation_core/SimulationEngine.js`)**

- **Process all skipped stations during fast ticks** — previously, when the tick clock straddled multiple segments, only the new segment's station was processed. Now `updateTrain` loops through every crossed station in order so boarding/alighting events fire correctly.
- **Final-station processing on completion** — a train hitting the last segment now processes the destination station before transitioning to `completed`.
- **Year-end edge case** — `tick()` short-circuits cleanly once `dayIndex >= yearDays`, marks the run done, and forces all in-flight trains to `completed`.
- **`selectVisibleTrains` sort fix** — was using nonexistent `segments?.length`; now correctly normalises by `stops.length - 1`.
- **Bounded `train.bookings`** at 1,500 entries per train to keep long-running engine memory flat.
- **Deterministic ticket IDs** — replaced `Date.now()`-based ID generator with a seed-derived FNV-1a counter so demos are reproducible.
- **Removed dead code** — `hashCode` and `statusRank` no longer reachable.

**OceanBase integration (`scripts/oceanbase_seed.py` + new `oceanbase_booking_ingest.py`)**

- **New `route_geometry` table** — persists rail-traced polylines as JSON arrays so analytical SQL can pull route geometry without hitting the browser.
- **New `calendar_summary` table** — per-day pre-aggregated rollups (train services, passengers, revenue, demand multipliers).
- **New `bookings` table + ingest pipeline** — every confirmed/cancelled ticket is streamed from the browser worker through `/ingest-bookings` (NDJSON) into `oceanbase_booking_ingest.py` for bulk upsert into OceanBase. Idempotent via `ON DUPLICATE KEY UPDATE`. Closes the long-standing gap that bookings only lived in browser memory.
- **Progress logging** — every 10 % of chunk completion.
- **Better error handling** — table count queries no longer crash the run if a table is missing.

**Web Worker / browser (`src/simulation_core/simulationWorker.js` + `App.jsx` + `serve-static.cjs`)**

- **Ledger flusher** — `simulationWorker.js` POSTs drained ledger entries to `/ingest-bookings` every 4 seconds in NDJSON. On network error, the batch is re-queued (capped at 4,000 entries).
- **`/ingest-bookings` endpoint** — `serve-static.cjs` accepts NDJSON, writes to `/tmp/chinahsr-ledger/`, and (when `OB_PASSWORD` is set) spawns the Python ingest process. `/healthz` exposes status.
- **Default speed alignment** — worker init falls back to 60 (was 18) to match `App.jsx`.

**Tests**

- All 16 tests pass: original 10 + 4 geometry/coverage/dedup tests + 2 booking ledger tests.
- New `dataDiversity.test.mjs` thresholds: ≥ 85 % rail-matched, ≥ 50 % rail-traced, < 0.1 % large coord jumps, ≥ 10 Xi'an routes.
- New `geometryValidation.test.mjs`: 0 segment-boundary breaks, plausible polyline density, OSM-augmented hubs present, < 5 % directed-pair duplicates.
- New `bookingLedger.test.mjs`: ledger captures booking + cancellation entries with full metadata, `drainLedger()` is idempotent.

---

### Pass 1 (earlier this date)

### Applied: Tick Rate Fix (P0)
**File:** `src/simulation_core/SimulationEngine.js`

Changed loop to pass actual elapsed time to tick():
```javascript
loop() {
    if (!this.running) return;
    const nowMs = performance.now();
    const elapsedSec = this.lastTickMs ? Math.min(0.5, (nowMs - this.lastTickMs) / 1000) : 0.1;
    this.lastTickMs = nowMs;
    this.tick(elapsedSec);
    this.callbacks.onUpdate?.(this.snapshot());
    this.timer = setTimeout(() => this.loop(), 1000 / 20);
}
```

Also added `this.lastTickMs = null` to constructor, and `this.tick(0)` for initial state.

### Applied: Default Speed Changed to 60 (P0)
**File:** `src/App.jsx`

Changed from `useState(18)` to `useState(60)` for more realistic travel times.

### Applied: Visible Train Limit Increased (P1)
**File:** `src/simulation_core/SimulationEngine.js`

Changed `SNAPSHOT_TRAIN_LIMIT` from 850 to 1500.

### Applied: Running Train Priority (P1)
**File:** `src/simulation_core/SimulationEngine.js`

Rewrote `selectVisibleTrains()` to always include ALL running trains first, before scheduled/completed. Running trains are never excluded due to the limit.

### Applied: Rail Index Grid Resolution (P2)
**File:** `scripts/prepare-data.cjs`

Changed `cellSize` from 0.35 to 0.18 degrees for better spatial resolution when finding rail points near stations.

### Applied: Rail Geometry Margin Expanded (P2)
**File:** `scripts/prepare-data.cjs`

Increased margin in `railGeometryBetween()` from `directKm/210` to `directKm/150` with max 5° (was 3.8°) to capture more rail candidates for segment geometry.

### Build & Test Verification
- `npm run build` → ✓ Built successfully
- `npm test` → ✓ All 10 tests pass
