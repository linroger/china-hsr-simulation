# China High-Speed Rail Simulation

> **A browser-native, data-backed simulation of the People's Republic of China's high-speed rail network** — featuring a segment-aware seat-inventory engine, revenue-management dynamic pricing, a discrete-event train movement core, real-time live-demand sales, a delta-snapshot Web Worker protocol, and a multiprocessing Python ETL pipeline, all rendered through Mapbox GL on top of OSM rail-corridor geometry.

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Mapbox](https://img.shields.io/badge/Mapbox%20GL-3.x-000000?logo=mapbox&logoColor=white)](https://docs.mapbox.com/mapbox-gl-js/)
[![Tests](https://img.shields.io/badge/tests-32%2F32%20passing-brightgreen)](#11-testing-strategy)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/Live%20demo-online-22c55e?logo=githubpages&logoColor=white)](https://linroger.github.io/china-hsr-simulation/)

### ▶ **[Open the live demo → linroger.github.io/china-hsr-simulation](https://linroger.github.io/china-hsr-simulation/)**

> The live demo runs the full browser simulation on the committed 1,800-route dataset. The OceanBase live-database API is local-only, so the deployed site uses the pre-generated route/station data and renders the rail network from the committed GeoJSON (so the map works even without a Mapbox token, via a tokenless MapLibre fallback).

🇨🇳 **[中文版 README](./README.zh-CN.md)**

---

## Live Preview

| Live Network Map | Operations Dashboard | Segment-aware Booking |
|:---:|:---:|:---:|
| ![Live Map](./screenshots/01-live-map.png) | ![Dashboard](./screenshots/02-operations-dashboard.png) | ![Booking](./screenshots/03-booking-panel.png) |
| 6,000 rolling-day detailed services moving along OSM rail-corridor polylines, color-coded by load factor. | Live KPIs plus OceanBase annual totals: 8.25M trains, 3.87B passengers, ¥1.49T revenue. | Quote/book any segment of any train; seats reused after passengers alight. |

### Demo video

The live network map at simulation speed — 6,000 rolling-day services moving along OSM rail-corridor polylines, color-coded by load factor, with the live event log streaming station boardings/alightings:

<video src="https://github.com/linroger/china-hsr-simulation/releases/download/demo-media/china-hsr-live-map.mp4" controls width="100%"></video>

> If the player above doesn't load in your client, watch it directly:
> **[▶ Live network map (36s)](https://github.com/linroger/china-hsr-simulation/releases/download/demo-media/china-hsr-live-map.mp4)** ·
> [clip 2 (35s)](https://github.com/linroger/china-hsr-simulation/releases/download/demo-media/china-hsr-live-map-2.mp4) ·
> [clip 3 (30s)](https://github.com/linroger/china-hsr-simulation/releases/download/demo-media/china-hsr-live-map-3.mp4) ·
> [4K still](https://github.com/linroger/china-hsr-simulation/releases/download/demo-media/china-hsr-live-map-4k.png) ·
> or **[try the live demo](https://linroger.github.io/china-hsr-simulation/)** yourself.

---

## Table of Contents

1. [Why this project](#why-this-project)
2. [Quick start](#quick-start)
3. [Highlights at a glance](#highlights-at-a-glance)
4. [System architecture](#system-architecture)
5. [Core algorithms](#core-algorithms)
   - 5.1 [Interval-calendar seat inventory](#51-interval-calendar-seat-inventory)
   - 5.2 [Revenue-management dynamic pricing](#52-revenue-management-dynamic-pricing)
   - 5.3 [Discrete-event simulation core](#53-discrete-event-simulation-core)
   - 5.4 [Rail network graph + A\* path tracing](#54-rail-network-graph--a-path-tracing)
   - 5.5 [Stratified diversity sampling](#55-stratified-diversity-sampling)
   - 5.6 [Operational realism layer](#56-operational-realism-layer)
   - 5.7 [Tick loop & self-correcting interval](#57-tick-loop--self-correcting-interval)
   - 5.8 [Background demand preload](#58-background-demand-preload)
   - 5.9 [Delta snapshot protocol](#59-delta-snapshot-protocol)
6. [Performance & optimization](#performance--optimization)
7. [Concurrency model](#concurrency-model)
8. [Data pipeline](#data-pipeline)
9. [OceanBase annual persistence](#oceanbase-annual-persistence)
   - 9.1 [Static server architecture](#91-static-server-architecture)
   - 9.2 [Booking ledger streaming](#92-booking-ledger-streaming)
   - 9.3 [12306 database migration](#93-12306-database-migration)
10. [Visualization layer](#visualization-layer)
11. [Testing strategy](#testing-strategy)
12. [Project structure](#project-structure)
13. [Configuration & secret handling](#configuration--secret-handling)
14. [Tech stack](#tech-stack)
15. [Roadmap](#roadmap)
16. [Disclaimer & data provenance](#disclaimer--data-provenance)
17. [License](#license)

---

## Why this project

This repository is a small but uncompromising attempt to model how a **nationwide passenger-rail booking and dispatch system** is engineered. It pulls together topics that show up at almost every senior-level interview at large platform companies:

- **Online interval scheduling** — the classic *can a seat be re-sold to a downstream passenger?* problem, solved as an interval-overlap calendar with O(k) check, O(k log k) insertion, and tested deterministically.
- **Revenue management / yield management** — multi-factor dynamic pricing combining distance fares, sigmoid-scarcity bid prices, time-to-departure pressure, peak surcharges, frequency relief, no-show buffers, and price elasticity.
- **Discrete-event simulation (DES)** — a 20 Hz tick loop driving 6,000 detailed rolling-day train services across 1,800 routes, with ordered route contracts, terminal turnaround return trips, planned-vs-actual delay modeling, no-show seat release, station-pressure metrics, and service-day rollover through the 365-day calendar.
- **Delta snapshot protocol** — the Web Worker sends only changed trains (~56% reduction) at 5 Hz, while the UI merges deltas into its local state using an Object.create(null) dictionary to avoid a production minifier collision.
- **OceanBase annual persistence** — a multiprocessing Python ETL creates 657,000 route-day service facts for a full year and bulk-loads them into OceanBase Desktop through its MySQL-compatible interface, with live booking ledger NDJSON streaming.
- **Spatial algorithms** — Haversine great-circle distance, perpendicular-distance pruning, polyline arc-length interpolation, and a custom **0.35°×0.35° grid hash index** that snaps generated route segments onto real OSM rail corridors.
- **Multithreading in the browser** — the entire simulation engine is moved off the React/Mapbox UI thread into a Web Worker; UI ↔ engine communicate through a typed promise-based message bus that handles `init`, `start`, `setSpeed`, `quoteTrip`, `bookTrip`, and `snapshot` traffic.
- **Engineering rigor** — deterministic seeded RNG (FNV-1a), 32 regression tests covering booking semantics, pricing monotonicity, no-show release, live demand, day rollover, monotonic train movement, terminal return trips, no-shortcut route geometry, OceanBase route contracts, data diversity, booking-ledger ingestion, cancellation ledger, 12306 migration dry-run, OceanBase rail-path geometry, dynamic pricing monotonicity, and scenario/realism checks (disruption slowdowns, demand surges, deterministic auto-disturbances, hourly demand shape, cancellation accounting, delay-cascade propagation), plus a `./run.sh` one-shot bootstrap that installs deps, regenerates data, runs tests, builds, and serves.

> **Designed for recruiters and engineers at Ant Group, Alibaba, Tencent, Baidu, Huawei** — the codebase is intentionally small (~3,500 LoC of hand-written logic across JS + Python) yet covers algorithms, distributed-systems reasoning, OR/yield management, full-stack TypeScript-equivalent React, GIS, and an end-to-end product story.

---

## Quick start

> **Requirements:** Node.js ≥ 18 (works with 18/20/22), npm, Python 3 for the OceanBase seed script, and ~600 MB of disk space. The browser app can run without OceanBase; annual persistence requires a reachable OceanBase MySQL-mode tenant and `OB_*` environment variables.

```bash
git clone https://github.com/linroger/china-hsr-simulation.git
cd china-hsr-simulation
./run.sh
```

That's it. The script will:

1. Verify your Node.js version.
2. `npm install` if `node_modules/` is missing.
3. Regenerate the station/route/Mapbox database (only if the upstream raw CSV/GeoJSON sources are present in the parent folder; otherwise it reuses the pre-built `public/*.json` artifacts that are committed to the repo).
4. Run the full test suite.
5. `vite build` the production bundle.
6. Launch a static server on `http://127.0.0.1:5174/`.

### Useful flags

```bash
./run.sh --dev          # Vite dev server with HMR (no production build)
./run.sh --skip-tests   # bootstrap + serve, skip the test suite
./run.sh --rebuild      # nuke node_modules/ and dist/, fresh install
PORT=8080 HOST=0.0.0.0 ./run.sh   # custom port / network exposure
```

### Windows

```cmd
run.cmd
run.cmd --dev
run.cmd --skip-tests
```

### Manual workflow (no script)

```bash
npm install
npm run prepare:data   # only if upstream CSV/GeoJSON sources exist
OB_PASSWORD=... npm run oceanbase:seed
npm test
npm run build
npm run serve          # http://127.0.0.1:5174/
```

---

## Highlights at a glance

| Domain | Numbers |
|---|---|
| **Stations indexed** | 3,147 with WGS-84 coordinates (3,058 from CSV + 89 OSM-augmented missing HSR hubs) |
| **HSR service records** | 7,278 real Chinese train OD records (G/D/C trains); 96.3% endpoints now resolved |
| **Generated simulation routes** | 1,800 across 28 macro-corridors and 30 origin-provinces, 224 unique origins |
| **Rolling-day detailed train services** | 6,000 for the active browser service day |
| **OceanBase annual train services** | 8,245,069 across 365 days, uncapped cumulatively |
| **OceanBase annual passengers / revenue** | 3,872,435,693 passengers / ¥1,493,000,206,022 |
| **OceanBase annual route-day facts** | 657,000 rows (365 days × 1,800 routes) |
| **Seat quota per train** | 554 (10 商务座 + 204 一等座 + 340 二等座 in 8-car formation) |
| **Detailed seat objects in rolling day** | ~3.32 million seat calendars for the active service day |
| **OSM rail-corridor features (rendering)** | 12,000 LineString features after simplification |
| **OSM rail graph for path-tracing** | 254,501 nodes / 275,919 edges built from 347,132 rail features |
| **Rail-traced route segments** | **83.7 %** path-traced via A\* over the generated OSM rail graph |
| **Rail-matched total** | **100.0 %** (rail-traced + corridor-sampled) — 0 long straight-line fallbacks |
| **OceanBase 12306 runtime routes** | 222 high-speed/EMU routes, 481 stations, 1,760 rail-graph edges, 5 rail-corridor edges, 0 ordered-stop straight fallbacks |
| **Geometry continuity** | 0 segment-boundary discontinuities, 0 long direct shortcuts in 231,757 coordinate transitions |
| **Snapshot interval** | 200 ms (5 Hz) from worker → UI |
| **Simulation tick rate** | 20 Hz (50 ms) inside the worker |
| **Max simulation speed** | 480× (24 hours in ~3 minutes) |
| **Default simulation speed** | 120× (24 hours in ~12 minutes) |
| **Tests** | 32/32 passing |

---

## System architecture

```
┌─────────────────────────────── Browser tab ────────────────────────────────┐
│                                                                            │
│  ┌─────────────────────── Main thread (UI) ─────────────────────────┐      │
│  │  React 19  ─  App.jsx                                            │      │
│  │     │                                                            │      │
│  │     ├─ HSRMap.jsx        (Mapbox GL: rails + stations + trains)  │      │
│  │     ├─ Dashboard.jsx     (Recharts: load, revenue, pressure)     │      │
│  │     └─ BookingPanel.jsx  (segment selector + quote + ticket)     │      │
│  │                                                                  │      │
│  │  SimulationWorkerClient   ◄──promise message bus──┐              │      │
│  │   .quoteTrip / .bookTrip / .setSpeed / .snapshot  │              │      │
│  └───────────────────────────────────────────────────┼──────────────┘      │
│                                                      │ postMessage         │
│                                                      ▼                     │
│  ┌────────────────── Web Worker thread ────────────────────────────┐       │
│  │  simulationWorker.js   (handles init/start/stop/...)            │       │
│  │      │                                                          │       │
│  │      ▼                                                          │       │
│  │  SimulationEngine                                               │       │
│  │   ├─ tick(realSeconds)    every 50 ms                           │       │
│  │   │     ├─ updateTrain    (state machine, segment progress)     │       │
│  │   │     ├─ processStation (boarding / alighting / no-show)      │       │
│  │   │     └─ sellRealtimeDemand  (live booking pressure)          │       │
│  │   ├─ SeatInventory[trainId]  ←─ interval calendar per train     │       │
│  │   └─ priceQuote / reconcileDemandForecast                       │       │
│  │                                                                 │       │
│  │  Snapshot publish every 200 ms ───► main thread setData()       │       │
│  │  (delta mode: only changed trains)                              │       │
│  └─────────────────────────────────────────────────────────────────┘       │
└────────────────────────────────────────────────────────────────────────────┘

                                build time
   raw CSV/GeoJSON ──► scripts/prepare-data.cjs ──► public/{station,route,
                                                          stations,rails}
```

The architecture is a **producer/consumer pipeline** with backpressure: the worker produces snapshots at 5 Hz, the UI consumes the latest snapshot and discards staler ones. All booking writes go through a request/response pair so the UI never reads partial state. The simulation tick runs at 20 Hz inside the worker, decoupled from the snapshot publish rate.

---

## Core algorithms

### 5.1 Interval-calendar seat inventory

The hardest correctness requirement of the whole project: **a seat must become available again to another passenger as soon as the original passenger alights, even mid-journey**. This is solved as an *interval-scheduling* problem on a per-seat calendar.

Each train holds a `SeatInventory` (`src/algorithms/seatInventory.js`) of 554 physical seats. Every seat carries a sorted list of occupied half-open intervals `[originIndex, destinationIndex)` keyed by station index along the train's stop list.

The availability test is the canonical interval-overlap predicate:

```js
export function intervalOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;          // half-open [a, b)
}

isSeatAvailable(seatId, originIndex, destinationIndex) {
  const seat = this.seatById.get(seatId);
  return seat.intervals.every(
    (held) => !intervalOverlaps(originIndex, destinationIndex,
                                held.originIndex, held.destinationIndex)
  );
}
```

Because intervals are kept sorted on insertion, the worst-case check is **O(k)** in the number of bookings on that seat (typically `k ≤ 6`), and insertion costs **O(k log k)** for the re-sort. For the simulator's seat-quota of 554 and routes of up to 12 stops, total seat-state per train fits in `O(seats × stops)` ≈ 6 KB — small enough that linear scans dominate any tree-based structure in practice.

#### Allocation scoring

`availableSeats({...})` returns seats *ranked* by a heuristic score (`scoreSeat` in `seatInventory.js:176`):

```js
function scoreSeat(seat, preference, originIndex, destinationIndex) {
  const tripLength = destinationIndex - originIndex;
  const preferenceBonus =
    preference === seat.position ? 100 :
    preference === 'any' && tripLength >= 4 && seat.position === 'window' ? 30 :
    preference === 'any' && tripLength < 4 && seat.position === 'aisle'  ? 20 : 0;
  const reuseBonus  = seat.intervals.length * 5;       // pack tighter for higher reuse
  const rowPenalty  = seat.row * 0.01;                  // mild front-rows preference
  return preferenceBonus + reuseBonus - rowPenalty;
}
```

Why a `reuseBonus`? It implements **best-fit packing**: prefer seats that already have neighbouring intervals, leaving long contiguous holes for future long-distance demand. This is a heuristic approximation to optimal interval colouring (a.k.a. interval-graph chromatic number = max overlap), but runs in `O(seats)` per booking instead of solving an NP-hard online colouring.

#### Group bookings & accessibility

`allocate({ groupSize, accessible, preference })` then groups candidates by `(car, row)` and prefers same-row seating for groups up to 6, falling back to "best-fit-N" if no single row has enough seats:

```js
function chooseGroup(candidates, groupSize) {
  if (groupSize === 1) return [candidates[0]];
  const byCarRow = new Map();
  for (const seat of candidates) {
    const key = `${seat.car}-${seat.row}`;
    if (!byCarRow.has(key)) byCarRow.set(key, []);
    byCarRow.get(key).push(seat);
  }
  for (const seats of byCarRow.values()) {
    if (seats.length >= groupSize) return seats.slice(0, groupSize);
  }
  return candidates.slice(0, groupSize);
}
```

#### Verified semantics

The single most important regression test (`tests/seatInventory.test.mjs`) encodes the seat-reuse contract:

```js
test('same seat is reusable after passenger alights but blocked for overlapping intervals', () => {
  const inv = new SeatInventory(routeStations, [{ id: 'S1', /* ... */ }]);

  inv.allocate({ originIndex: 0, destinationIndex: 2, /* A → C */ });
  assert.equal(inv.isSeatAvailable('S1', 1, 3), false);   // overlap B→D blocked
  assert.equal(inv.allocate({ originIndex: 1, destinationIndex: 3 }), null);

  inv.allocate({ originIndex: 2, destinationIndex: 3, /* C → D */ });
  // S1 now holds [A,C) and [C,D) — reused after alighting
});
```

### 5.2 Revenue-management dynamic pricing

`src/algorithms/pricing.js` implements a compact yield-management quote. Inputs are `{ distanceKm, seatClass, loadFactor, hoursToDeparture, departureHour, frequencyRank, noShowRisk, elasticity }` and the output is a deterministic price plus the multiplier breakdown — so the UI can render *why* a price is what it is.

```js
const distanceDiscount = distanceKm > 1200 ? 0.88 :
                         distanceKm > 800  ? 0.92 :
                         distanceKm > 500  ? 0.96 : 1;
const baseFare        = distanceKm * 0.46 * config.multiplier * distanceDiscount;
const scarcity        = 1 + sigmoid((loadFactor - 0.62) * 7) * 0.48;
const timePressure    = hoursToDeparture < 2  ? 1.32 :
                        hoursToDeparture < 8  ? 1.18 :
                        hoursToDeparture < 24 ? 1.08 :
                        hoursToDeparture > 168 ? 0.9  : 1;
const peak            = (departureHour ∈ [7-9] ∪ [17-20]) ? 1.16 : 1;
const frequencyRelief = 1 - min(0.14, max(0, frequencyRank) * 0.14);
const noShowBuffer    = 1 + min(0.06, noShowRisk);
const bidPrice        = distanceKm * 0.46 * loadFactor^1.8 * config.multiplier * 0.42;
const raw             = (baseFare + bidPrice) * scarcity * timePressure
                                              * peak * frequencyRelief * noShowBuffer;
```

The interesting design choices:

- **Sigmoid scarcity** (`1/(1+e^-x)`) gives a smooth demand curve centered at 62 % load factor — empirically close to where Chinese HSR begins shedding 95-折 discounts. Linear scaling would over-react to early bookings.
- **`bidPrice = d · loadFactor^1.8 · classMul · 0.42`** is a compact bid-price ([Talluri & van Ryzin, *The Theory and Practice of Revenue Management*](https://link.springer.com/book/10.1007/b139000)) approximation: as the segment fills, the marginal opportunity cost of seat consumption grows super-linearly. Adding `bidPrice` to `baseFare` produces **strictly monotonic prices in load factor** for any seat class.
- **Frequency relief**: well-served corridors (`frequencyRank > 0.5`) discount up to 14 % to model competitive pressure from neighbouring trains.
- **No-show buffer**: a small bump (≤ 6 %) covers the expected revenue loss from the no-show release path (§5.6).

The companion `reconcileDemandForecast({ routeDistanceKm, segmentLoad, dayOfWeek, hour, stationTier })` produces a 0.7×–1.7× *demand multiplier* used to **inflate effective load factor** when quoting, so a Beijing-South 8 a.m. business-class quote prices in *future* expected occupancy, not just current.

The pricing test (`tests/pricing.test.mjs`) verifies monotonicity:

```
business@15%   >  first@15%   >  second@15%
second@93%     >  second@15%
bidPrice@93%   >  bidPrice@15%
```

### 5.3 Discrete-event simulation core

`SimulationEngine` (`src/simulation_core/SimulationEngine.js`) is a ~1,650-line hand-written DES runtime. Key responsibilities:

| Method | Purpose |
|---|---|
| `createScheduledServices(routes, maxTrains)` | Generates the rolling-day detailed service plan from 1,800 persisted route contracts using `allocateDailyServices`, which scales desired service counts proportionally while respecting a per-route minimum of 2. |
| `tick(realSeconds)` | Advances `nowMinutes` by `realSeconds × speed / 60`, updates every train, sells live demand every 6 ticks, decays booking velocity per simulated minute, and handles calendar/day-boundary transitions. |
| `updateTrain(train)` | Advances segment index by accumulating elapsed time over `segmentMinutes[]`; transitions outbound trains into a terminal turnaround return leg and completes only after the return reaches the original station. Guards against backward movement with epsilon tolerance (1e-4). |
| `processStation(train, idx)` | Per-station boarding/alighting/no-show logic, mutates booking statuses in-place. Uses lazy-built `_bookingIndexes` (byOrigin/byDestination Maps) for O(1) station lookup. |
| `quoteTrip(...)` | Pure read-only price computation, instrumented with `performance.now()` to expose `algorithmMs` to the UI. |
| `bookTrip(...)` | Serializable read-modify-write through `quoteTrip` + `inventory.allocate`; rolls back if the seat calendar shifted between quote and commit (SE-3 guard). Records ledger entry for persistence. |
| `snapshot()` | Builds a 800-train cap of `{ active ∪ near-term ∪ recently-completed }`, plus booking-options list, network roll-up, and stats. Caches calendar, bookings, events, and serialized stops to avoid recomputation. |
| `cancelBooking(ticketId)` | Releases seat inventory, filters booking arrays, records cancellation ledger entry. |

The tick frequency is **20 Hz** (50 ms) inside the worker, with a self-correcting interval that measures actual elapsed time to prevent callback pile-up. Snapshots ship to the UI every **200 ms** (5 Hz) — a producer/consumer rate decoupling that keeps Mapbox `setData` calls under the React 60 fps budget while ensuring trains move at the exact simulation speed visually.

#### State machine

```
                 outbound departureMinute reached
   scheduled ─────────────────────────────────► running
                                                   │
                              elapsed ≥ Σ outbound segmentMinutes
                                                   ▼
                                        terminal turnaround dwell
                                                   │
                              return departureMinute reached
                                                   ▼
                                                running
                                                   │
                                elapsed ≥ Σ return segmentMinutes
                                                   ▼
                                                completed
```

Each train is assigned one ordered route variant at a time. The outbound variant uses `route.stops[0..n]`; the return variant uses the exact reverse stop sequence and reversed segment geometries. `processedStationIndexes` is reset per leg and remains a `Set` so `processStation` is idempotent under tick clock jitter (a tick may straddle a station crossing), which prevents A-B-A oscillation unless that sequence is explicitly present in the persisted route contract.

#### Service day rollover

When `calendar.dayIndex` advances, `advanceServiceDay()` creates a fresh fleet of scheduled trains for the new day while **retaining up to 2,000 non-completed trains** from previous days. This preserves overnight bookings and late-running services across the day boundary. The retained trains continue their journey; new trains are preloaded with background demand via the chunked preload mechanism (§5.8).

#### Live-demand pressure

Every 6 ticks (`tickCounter % 6 === 0`), `sellRealtimeDemand` injects booking requests biased by:

```
weight(train) = max(0.1, frequencyRank + 0.2)
              × departurePressure(t)             ← bell-curved around 9 a.m.
              × max(0.15, 1 - currentLoadFactor) ← stop hammering already-full trains
```

This is why revenue and passenger counters move *during* the live preview — the system isn't a static playback of preloaded bookings.

### 5.4 Rail network graph + A\* path tracing

The naive projection-by-chord approach in earlier iterations was discovered to produce **scrambled coordinate arrays** when rail lines curved (15,077 large jumps across segment geometries — visible as trains "teleporting" or appearing over water). The current implementation replaces it with a **two-stage geometry pipeline**:

**Stage 1 — Build a rail graph from OSM.** All 347,132 OSM `railway=rail` LineStrings are parsed and their vertices snapped onto a 0.0055° (~600 m) lattice. Adjacent vertices in the same LineString form an edge; vertices from different LineStrings within the same lattice cell unify into the same node, forming a **single connected graph at junctions**:

```js
function buildRailNetwork(osmFeatures) {
  const cellSize = 0.0055;          // ~600 m
  const cellMap = new Map();
  const nodes  = [];                 // { lng, lat, neighborList, refCount }
  for (const feature of osmFeatures) {
    let prevId = null;
    for (const [lng, lat] of feature.coordinates) {
      const id = findOrCreateNode(lng, lat);   // unifies neighbouring vertices
      if (prevId !== null && prevId !== id) {
        nodes[prevId].neighbors.add(id);
        nodes[id].neighbors.add(prevId);
      }
      prevId = id;
    }
  }
  // …attach a 0.04° spatial bucket index for O(1) nearest-node lookup
}
```

The result: **254,501 nodes / 275,919 edges** — a Eurail-scale rail graph that's still small enough to run A\* over in milliseconds.

**Stage 2 — A\* search between station endpoints.** For each route segment, both stations are snapped to their nearest rail node via the spatial bucket index. A bounded A\* search with **straight-line distance to goal as admissible heuristic** finds the actual rail path:

```js
function dijkstraPath(network, startId, goalId, directKm) {
  const heap = new BinaryHeap();
  heap.push({ id: startId, dist: 0, score: distance(startNode, goalNode) });
  const maxKm = Math.max(180, directKm * 2.2);   // bounded exploration
  while (heap.size()) {
    const { id, dist } = heap.pop();
    if (id === goalId) return reconstructPath(/* … */);
    for (const neighborId of nodes[id].neighborList) {
      const newDist = dist + distance(node, neighbor);
      if (newDist > maxKm) continue;             // prune wandering paths
      heap.push({ id: neighborId, dist: newDist,
                  score: newDist + distance(neighbor, goalNode) });
    }
  }
}
```

**Detour guard**: paths that wander more than 1.85× the chord distance are rejected and the next strategy is tried.

**Stage 3 — Simplify + repair.** Successful A\* paths are then:

1. **Douglas-Peucker simplified** to ≤ 70 vertices per segment with adaptive tolerance (0.0008°–0.0035° depending on segment length) — preserves visible curvature while shrinking the route file from 78 MB → 13 MB.
2. **Coordinate rounded** to 5 decimals (~1.1 m precision).
3. **Big-jump repair pass** — any residual coord-to-coord jump > 0.45° is interpolated linearly. 1,536 segments needed minor repair, and the regression suite now separately rejects long single-hop shortcuts.

**Stage 4 — Fallbacks.** When A\* fails (e.g., off-graph stations on incomplete OSM data), the algorithm falls back to **corridor sampling** (the older bbox-based candidate-vertex approach), and finally to a straight chord. Current breakdown:

| Geometry source | Coverage |
|---|---:|
| `rail-traced` (A\* over rail graph) | **83.7 %** |
| `hotosm-rail-corridor` (corridor sampling) | 16.3 % |
| `station-straight-fallback` (chord) | 0.0 % |

The result is **0 long direct shortcuts and 0 segment-boundary discontinuities** across 231,757 coordinate transitions and 6,138 segment-to-segment boundaries.

#### Polyline arc-length interpolation

At runtime `interpolateLine(coordinates, progress)` (`src/simulation_core/geo.js:18`) does **arc-length-parameterized interpolation** rather than coordinate-index interpolation:

```js
const lengths = coords.slice(0,-1).map((c,i) => haversineKm(c, coords[i+1]));
const total = lengths.reduce((a,b)=>a+b, 0);
let target = total * progress;
for (let i = 0; i < lengths.length; i++) {
  if (target <= lengths[i]) return interpolateCoord(coords[i], coords[i+1], target/lengths[i]);
  target -= lengths[i];
}
```

This means a train at 50 % `segmentProgress` is at exactly 50 % of the *real geographic distance* along the polyline, not 50 % of its vertex index — important when polyline density varies (urban hubs have more vertices than rural stretches).

### 5.5 Stratified diversity sampling

The first naive implementation took the first 280 routes from `line.csv`, which clustered everything along a few trunk corridors. The dashboard looked thin. The fix was a two-pass **stratified sampling** algorithm in `selectDiverseRecords()` (`scripts/prepare-data.cjs:177`):

```js
function selectDiverseRecords(records, limit) {
  const byCorridor = groupBy(records, r => r.corridor);
  const selected = [];
  const seen = new Set();

  // Pass 1: every macro-corridor gets a baseline of 4 routes,
  // sorted by service-frequency × distance.
  for (const corridorRecs of [...byCorridor.values()].sort((a,b) => b.length - a.length))
    for (const rec of corridorRecs.slice().sort(compareRoutePriority).slice(0, 4))
      addRecord(rec);

  // Pass 2: round-robin by origin-province until limit is reached.
  const byProvince = groupBy(records.sort(compareRoutePriority), r => r.originProvince);
  while (selected.length < limit) {
    let progress = false;
    for (const recs of byProvince.values()) {
      const next = recs.find(r => !seen.has(recordKey(r)));
      if (next) { addRecord(next); progress = true; if (selected.length >= limit) break; }
    }
    if (!progress) break;
  }
  return selected.slice(0, limit);
}
```

The output of the data-diversity test (`tests/dataDiversity.test.mjs`) asserts:

- ≥ 1,000 simulation routes
- ≥ 70 unique origin stations
- ≥ 24 unique origin provinces (China has 31 provincial-level regions)
- ≥ 20 unique macro-corridors (defined by `North/South/East/West/Central/Southwest/Northwest/Northeast` 7-region taxonomy)
- ≥ 85% rail-matched segments
- ≥ 50% rail-traced (graph-followed)

### 5.6 Operational realism layer

A toy simulator is a static playback. This one models *operating variance*:

| Effect | Where | Formula / value |
|---|---|---|
| **Hub dwell pressure** | `realisticSegmentMinutes` | +3 min at national hubs, +1.5 min at regional hubs |
| **Weather drag** | `deterministicNoise(...) > 0.94` | +4 min on roughly 6 % of segments |
| **Dispatch slack** | `deterministicNoise(...) > 0.86` | +2 min on roughly 14 % of segments |
| **Surge dispatch pressure** | `realisticSegmentMinutes` | `max(0, capacityMultiplier - 1) × 3.2` min during holidays |
| **Trunk bias** | `scheduledDepartureMinute` | trunk routes (`frequencyRank > 0.55`) depart 35 min earlier |
| **No-show probability** | `noShowProbability(...)` | base 1.8 % (商务) → 3.8 % (二等), -0.6 pp at hubs, +0.6 pp short-hop |
| **No-show release** | `processStation` | seat interval is freed at the originating station for downstream resale |
| **Live delay tracking** | `currentDelay(train)` | running difference between `Σ segmentMinutes` and `Σ plannedSegmentMinutes` |
| **Booking velocity decay** | `tick()` | velocity × 0.95 per simulated minute; drops below 0.1 are deleted |

This is what makes the dashboard feel alive: average delay drifts as trains pass hubs, station pressure spikes when many trains converge, and revenue ticks upward with live-demand sales.

#### Deterministic seeded RNG

All randomness flows through a single FNV-1a-derived PRNG (`SimulationEngine.random(...parts)`):

```js
function seeded(key) {
  let hash = 2166136261;
  for (const ch of key) {
    hash ^= ch.charCodeAt(0);
    hash  = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1_000_000) / 1_000_000;
}
```

Given a fixed `seed`, every call resolves to the same value — making test runs and demos perfectly reproducible.

### 5.7 Tick loop & self-correcting interval

The simulation loop is not a naive `setInterval(..., 50)` because `tick()` + `snapshot()` can occasionally exceed 50 ms (especially during day-boundary transitions). Instead, the engine measures actual elapsed time and schedules the next frame to maintain ~20 Hz without callback pile-up:

```js
loop() {
  const frameStartMs = performance.now();
  const elapsedSec = this.lastTickMs
    ? Math.min(0.5, (frameStartMs - this.lastTickMs) / 1000)
    : 0.1;
  this.lastTickMs = frameStartMs;
  this.tick(elapsedSec);
  const processingMs = performance.now() - frameStartMs;
  const intervalMs = Math.max(1, Math.round(1000 / 20 - processingMs));
  this.timer = setTimeout(() => this.loop(), intervalMs);
}
```

The `elapsedSec` is capped at 0.5 seconds to prevent a "catch-up storm" if the tab was backgrounded. At 480× speed, each 50 ms tick advances the simulation by 400 simulated seconds (~6.7 minutes), so a full 24-hour day completes in roughly 3 minutes of real time.

### 5.8 Background demand preload

Before the simulation starts moving trains, every scheduled train is pre-populated with simulated passengers to achieve a realistic initial load factor. This happens in two phases:

**Phase 1 — Synchronous preload during engine init.** If `preloadDemand: true` (default), the constructor calls `preloadDemand()` which loops through all trains and calls `preloadTrainDemand()` for each. Each train gets a target load factor derived from:

```
targetLoad = min(0.96, 0.58 + demandIntensity × 0.16 + (calendarDemand - 1) × 0.14 + random × 0.12)
```

The engine then attempts bookings with randomized origin/destination indices, seat classes, and group sizes until the target passenger count is reached or attempts are exhausted.

**Phase 2 — Chunked background preload in the worker.** If synchronous preload is disabled (to speed up worker init), the worker calls `preloadDemandBatch(60)` in a recursive `setTimeout` chain that processes 60 trains per chunk with 8 ms gaps. This spreads ~7 seconds of booking work across hundreds of micro-tasks, keeping the UI responsive. Progress snapshots are emitted after each chunk.

### 5.9 Delta snapshot protocol

Shipping the full 800-train snapshot every 200 ms wastes bandwidth and CPU. The worker implements a **delta snapshot** protocol:

```
Full snapshot  ──► on init, booking, manual refresh, or day boundary
Delta snapshot ──► on every tick (only changed trains)
```

The worker tracks `lastPublishedTrains` as a `Map<trainId, serializedTrain>`. On each tick, it compares every train in the current snapshot against its last-published version using `trainStateChanged(a, b)`:

```js
function trainStateChanged(a, b) {
  return a.status !== b.status
    || a.currentSegmentIndex !== b.currentSegmentIndex
    || Math.abs(a.routeProgress - b.routeProgress) > 1e-6
    || Math.abs(a.loadFactor - b.loadFactor) > 1e-4
    || a.passengerCount !== b.passengerCount
    || a.currentStation !== b.currentStation
    || a.nextStation !== b.nextStation
    || Math.abs(a.coords?.lng - b.coords?.lng) > 1e-8
    || Math.abs(a.coords?.lat - b.coords?.lat) > 1e-8;
}
```

Only trains that changed are sent. Trains that left the visible set (e.g., completed) are reported via `removedTrainIds` so the UI can delete them from its local state.

On the UI side, `App.jsx` `mergeSnapshot(previous, nextSnapshot)` patches delta trains into the previous state:

```js
function mergeSnapshot(previous, nextSnapshot) {
  if (!previous || nextSnapshot.bookingOptions) return nextSnapshot;
  if (nextSnapshot.delta) {
    const trainsById = Object.create(null);
    for (const train of previous.trains || []) trainsById[train.id] = train;
    for (const train of nextSnapshot.trains) trainsById[train.id] = train;
    for (const id of nextSnapshot.removedTrainIds || []) delete trainsById[id];
    return {
      ...nextSnapshot,
      trains: Object.values(trainsById),
      bookingOptions: previous.bookingOptions.slice(),
    };
  }
  return { ...nextSnapshot, bookingOptions: previous.bookingOptions.slice() };
}
```

> **Production bug story:** The original implementation used `new Map()` for `trainsById`. After Vite's esbuild minification, `Map` was renamed to `m`, which collided with an existing local variable `m` in the bundle scope, causing `m is not a constructor` at runtime. The fix was replacing `Map` with `Object.create(null)` + `Object.values()` — a plain-object dictionary avoids the minifier collision entirely and is actually faster for string-keyed lookups.

This protocol reduces snapshot payload by **~56%** for typical 200-active-train workloads.

---

## Performance & optimization

| Concern | Optimization |
|---|---|
| **UI thread starvation** | The whole simulation moved to a Web Worker (`simulationWorker.js`). React only does paint + interaction. |
| **Mapbox setData churn** | Snapshots at 5 Hz with delta mode (only changed trains sent); train GeoJSON capped at 800 visible features (active ∪ near-term ∪ recently-completed); completed trains drop out of the feature collection. |
| **Mapbox style reuse** | Single `mapbox-gl` instance across renders, layers added once on `'load'`, train source updated by `getSource('trains').setData(...)` — no full re-render. |
| **Snapshot serialization** | `snapshot()` cherry-picks only fields needed by the UI; delta snapshots send only changed trains (~56% reduction); cached serialized stops, calendar, bookings, and events arrays avoid recomputation. |
| **OSM payload** | Hard caps: 12,000 features and 1.4 M vertices total, with adaptive vertex stride per LineString. |
| **CSV parsing** | Single pass with quote-aware splitter, no regex backtracking. |
| **Spatial query** | 0.35° grid hash index (§5.4) gives sub-millisecond lookups vs. linear O(features) scan. |
| **Booking quote latency** | `algorithmMs` shown in UI: typically 0.1–1 ms per quote on a 2024 MacBook. |
| **Test suite** | Pure ESM `node:test` runner — full suite ~1.1 s. |
| **Delta snapshots** | Worker sends only trains whose state changed since last publish. Full snapshots sent on init, booking, manual, and day-boundary only. |
| **Build output** | Vite + Rollup code-splits the worker bundle (`simulationWorker-*.js` ~40 KB) and lazy-loads Dashboard/BookingPanel chunks from the main app. |
| **Static server** | Zero-dependency Node.js `http` server with on-the-fly gzip for `.js`, `.css`, `.json`, `.geojson`, and `.html`. |
| **Worker init** | Background chunked demand preload (60 trains × 8 ms) instead of synchronous 7-second blocking preload. |

---

## Concurrency model

```
main thread                                 worker thread
───────────                                 ─────────────

new SimulationWorkerClient({ onSnapshot })
   │ new Worker(simulationWorker.js, type:module)
   │
   │ ──postMessage({id:1, type:'init', payload})──►   onmessage('init')
   │                                                    engine = new SimulationEngine(...)
   │                                                    publish initial snapshot
   │ ◄────postMessage({type:'snapshot', ...})─────────┘
   │ ◄────postMessage({type:'response', id:1, ...})───
   │
   │ ──postMessage({id:2, type:'start'})───────────►   engine.start()
   │                                                    setInterval(()=>postSnapshot(),200)
   │ ◄────postMessage({type:'snapshot'})······ every 200 ms
   │
   │ ──postMessage({id:3, type:'quoteTrip',...})──►    respond(engine.quoteTrip(...))
   │ ◄────postMessage({type:'response', id:3,...})
```

Three things make this clean:

1. **Promise-based RPC.** `SimulationWorkerClient.call(type, payload)` allocates an auto-incrementing `id`, stashes `{resolve, reject}` in a `Map`, and posts the message. The worker echoes the same `id` back in its `'response'` envelope, the client looks it up, settles the promise, and deletes the entry.
2. **Out-of-band push.** Snapshots are *not* request/response — they're `'snapshot'` messages with no `id`, dispatched to `onSnapshot()`. This avoids a polling loop.
3. **Backpressure tolerance.** If the UI is slow, snapshots queue and React only re-renders on the *latest* one (`setSnapshot(nextSnapshot)`), because the worker keeps publishing regardless.

This is the same pattern used in production by VS Code's extension host, Figma's render thread, Excel for the Web's calc engine, etc.

---

## Data pipeline

`scripts/prepare-data.cjs` is a ~1,540-line ETL that produces four artifacts in `public/`:

1. **`station-data.json`** — 3,147 stations (3,058 from CSV + 89 OSM-augmented missing HSR hubs like 西安北 / 昆明南 / 南宁东 / 香港西九龙). The augmentation pass scans referenced station names from `line.csv` against the OSM `name` / `name:zh` fields, with `站` / `火车站` suffix-stripped fallback variants. Province/city for OSM-augmented stations are inferred from the nearest CSV station within 100 km.
   Tier classification:
   - `national-hub`: 36-name lookup table covering provincial capitals and major HSR hubs (北京/上海/广州/深圳/成都/重庆/武汉/郑州/西安/南京/杭州/长沙/天津/昆明/南宁/福州/厦门/哈尔滨/沈阳/大连/长春/济南/青岛/合肥/南昌/贵阳/乌鲁木齐/呼和浩特/银川/西宁/兰州/太原/石家庄/香港西九龙) plus their named directional sub-stations
   - `regional-hub`: `sourceCount ≥ 4` or name ends with a cardinal `南/西/东/北` suffix
   - `local`: everything else
2. **`route-data.json`** — 1,800 simulation routes with full per-segment **rail-traced** geometry, explicit `routeContract` metadata for outbound/return variants, plus all 7,278 raw service records for provenance. Routes are deduplicated per directed (origin, destination) pair, keeping the highest-frequency variant.
3. **`hsr-stations.geojson`** — Mapbox-ready station Point features.
4. **`hsr-rails.geojson`** — Mapbox-ready rail LineString features (≤ 12,000, ≤ 1.4 M vertices), prioritising HSR-named lines (高速 / 客运 / 城际 / 动车 / 高铁).

Each generated route carries:

```jsonc
{
  "id": "route-42-G7001",
  "code": "G7001",
  "trainNo": "240000G70010",
  "type": "G",
  "origin": "北京南",
  "destination": "上海",
  "totalDistanceKm": 1318,
  "frequencyRank": 0.92,
  "corridor": "East China / North China",
  "originProvince": "北京",
  "destinationProvince": "上海",
  "provenance": "Real train origin/destination; intermediate stops simulation-derived...",
  "stops": [ { "name": "...", "lng": ..., "lat": ..., "tier": "national-hub",
              "simulatedStop": true, "dwellMinutes": 6 }, ... ],
  "segments": [ { "from": "...", "to": "...", "distanceKm": 142,
                  "speedLimitKmh": 350, "track": "double", "signaling": "CTCS-3 simulated",
                  "geometry": [[lng,lat], ...], "geometrySource": "hotosm-rail-corridor" }, ... ],
  "geometry": [ /* merged dedupe of all segment polylines */ ]
}
```

The pipeline is **deterministic and idempotent** — given the same raw inputs, it produces byte-identical outputs.

---

## OceanBase annual persistence

> **Why OceanBase?** The browser simulation engine keeps seat-level detail for a single rolling service day (~6,000 trains, ~3.3 M seat calendars). That is already the practical limit of a Web Worker heap. A full 365-day horizon with the same fidelity would need ~2.2 B seat objects — far beyond what any browser can hold. OceanBase solves this by storing **route-day aggregate facts** (not seat-level detail) for the entire year, giving the dashboard annual totals alongside the live day.

### What OceanBase is

[OceanBase](https://github.com/oceanbase/oceanbase) is an open-source **distributed SQL database** originally built by **Ant Group** to power Alipay and Taobao. It is wire-compatible with MySQL, supports HTAP (Hybrid Transactional/Analytical Processing), and handles petabyte-scale workloads with strong consistency. For this project we use **OceanBase Desktop** (or any MySQL-mode tenant) as the analytical persistence layer.

### Dual-mode architecture

The project operates in two complementary modes:

| Mode | Fidelity | Scale | Runtime |
|---|---|---|---|
| **Browser detailed mode** | Seat-level interval calendars | 1 rolling day (~6 K trains, ~3.3 M seats) | Web Worker at 20 Hz |
| **OceanBase annual mode** | Route-day aggregate facts | 365 days (~8.25 M trains, 657 K route-day rows) | Python multiprocessing + bulk INSERT |

### Schema design

The seed script creates a **star schema** with route-contract lookup tables, raw rail-track storage, and four fact tables:

```sql
-- Dimension tables
stations          (station_id PK, name, province, city, bureau, kind, tier, lng, lat)
routes            (route_id PK, code, train_no, route_type, origin, destination, ...)
route_stops       (route_id, stop_index PK, station_id, name, province, ...)
route_segments    (route_id, segment_index PK, from_station, to_station, distance_km, ...)
route_geometry    (route_id, segment_index PK, geometry_source, coordinate_count, coordinates_json)
route_variants    (route_variant_id PK, route_id, direction, origin, destination, stop_sequence_json)
route_variant_stops
                  (route_variant_id, stop_index PK, station_id, name, province, ...)
route_variant_segments
                  (route_variant_id, segment_index PK, from_station, to_station, ...)
route_variant_geometry
                  (route_variant_id, segment_index PK, geometry_source, coordinate_count, coordinates_json)
rail_tracks       (rail_track_id PK, osm_id, name, properties_json, geometry_json)

-- Fact tables
simulation_runs   (run_id PK, start_date, end_date, days, route_count, station_count,
                   total_route_day_rows, total_train_services, estimated_passengers,
                   estimated_revenue, surge_day_count, generated_seconds)
daily_route_services
  (run_id, service_date, day_index, route_id,
   service_count, demand_multiplier, capacity_multiplier, price_surge_multiplier,
   estimated_passengers, estimated_revenue,
   is_weekend, is_holiday, calendar_label)
calendar_summary
  (run_id, service_date, day_index, day_of_week, is_weekend, is_holiday, calendar_label,
   demand_multiplier, capacity_multiplier, price_surge_multiplier,
   total_train_services, total_passengers, total_revenue)
bookings
  (ticket_id PK, run_id, train_id, train_code, route_id,
   passenger_id, passenger_name,
   origin_station, destination_station, origin_index, destination_index,
   seat_class, seat_count, seats_json, price, distance_km,
   booked_at_minute, booked_at_clock, service_date, status, no_show)
```

- `route_geometry` persists canonical outbound rail-traced polylines as JSON arrays so analytical SQL can pull route geometry without hitting the browser.
- `route_variants` and its child tables persist both `outbound` and `return` route contracts. A train never chooses its next station opportunistically; it advances monotonically through the active variant's ordered stops, then flips to the return variant at the terminal.
- `rail_tracks` stores the rendered HOTOSM rail GeoJSON features as queryable raw track geometry. Route geometry can therefore be audited against both the generated service route and the underlying rail layer.
- `calendar_summary` is a per-day rollup that supports analyst queries like *"average passenger load on Spring Festival vs. summer peak"* without scanning the route-day fact table.
- `bookings` is a **live booking ledger**: every confirmed/cancelled ticket is streamed from the browser worker through a small `/ingest-bookings` HTTP endpoint into `scripts/oceanbase_booking_ingest.py`, which bulk-upserts it into OceanBase. This closes the long-standing gap that bookings only lived in browser memory.

### 9.1 Static server architecture

`scripts/serve-static.cjs` is a ~450-line zero-dependency Node.js server that serves the production Vite bundle **and** acts as a lightweight API backend. It runs on `http://127.0.0.1:5174/` by default.

**Static file serving:**
- Serves files from `dist/` with correct MIME types
- On-the-fly gzip compression for `.js`, `.css`, `.json`, `.geojson`, `.html`, `.svg`, `.txt`
- `Cache-Control: no-store, no-cache, must-revalidate` for `index.html` to prevent stale JS chunk caching after rebuilds
- Falls back to `dist/index.html` for SPA routes (client-side routing)
- Rejects parent-directory traversal (`..`) with 403

**API endpoints:**

| Endpoint | Method | Purpose |
|---|---|---|
| `/ingest-bookings` | POST | Receives NDJSON booking batches from the worker, writes to ledger directory, optionally spawns Python ingest process |
| `/healthz` | GET | Returns `{ok, ledgerIngest, ledgerDir, ledger}` — observable health check |
| `/ledger-stats` | GET | Returns queue metadata: `pendingFiles`, `pendingBytes`, oldest/newest pending file |
| `/api/oceanbase-simulation-data` | GET | Queries OceanBase for 12306 runtime route data with fallback chain |

**OceanBase data export fallback chain:**

```
1. OrbStack VM query (orb -m oceanbase-desktop)  ──►  if local + orb available
2. Direct PyMySQL query                            ──►  if OB_PASSWORD set
3. public/oceanbase-simulation-data.json           ──►  if < 24h stale
4. 503 error                                       ──►  last resort
```

The export is cached in memory for 5 minutes (`OCEANBASE_EXPORT_TTL_MS=300_000`) to avoid hammering the database on every dashboard refresh.

**Environment-driven behavior:**

```bash
# Disable OceanBase ingest entirely
CHINAHSR_DISABLE_INGEST=1 npm run serve

# Use explicit OrbStack VM for local OceanBase Desktop
CHINAHSR_OCEANBASE_VIA_ORB=1 npm run serve

# Custom ledger directory
CHINAHSR_LEDGER_DIR=/var/lib/chinahsr-ledger npm run serve

# Custom export cache TTL and max payload size
CHINAHSR_OCEANBASE_EXPORT_TTL_MS=600000 CHINAHSR_OCEANBASE_EXPORT_MAX_BYTES=50000000 npm run serve
```

### 9.2 Booking ledger streaming

```
SimulationEngine.bookTrip()           ─►  ledger.push(entry)
                                          │
                  worker.flushLedger()  ◄─┘  (every 4 s)
                          │
                          ▼  POST /ingest-bookings (NDJSON)
                  serve-static.cjs
                          │
                          ▼  write to LEDGER_DIR/*.ndjson
                          │
                          ▼  spawn python3 oceanbase_booking_ingest.py --input ...
                  scripts/oceanbase_booking_ingest.py
                          │
                          ▼  PyMySQL executemany INSERT ... ON DUPLICATE KEY UPDATE
                  OceanBase `bookings` table
```

- **NDJSON format**: each line is a self-contained JSON object. The server buffers up to 4 MB per POST, writes to a timestamped `.ndjson` file, then spawns the ingest process.
- **Idempotent**: `ON DUPLICATE KEY UPDATE` lets cancellations and status flips overwrite the original confirm row instead of inserting duplicates.
- **Backpressure-tolerant**: when OceanBase is unreachable, the worker re-queues the failed batch (capped at 4,000 entries) and retries on the next interval. The browser keeps working — only the persistence trail pauses.
- **Opt-out**: if `OB_PASSWORD` is not set or `CHINAHSR_DISABLE_INGEST=1`, the static server still buffers NDJSON files into the ledger directory so they can be replayed later.
- **Observable**: `GET /healthz` reports ledger ingest status plus queue metadata (`pendingFiles`, `pendingBytes`, oldest/newest pending file), and `GET /ledger-stats` exposes the same replay queue summary directly.

### 9.3 12306 database migration

A local SQLite snapshot (`12306.db`) contains scraped 12306 route data. The migration path converts this into OceanBase schema:

```bash
# Review the SQLite snapshot without touching a live tenant
npm run 12306:review

# Load into a reachable OceanBase MySQL-mode tenant
OB_PASSWORD=... npm run 12306:migrate -- --create-database --truncate

# Export simulation-ready data from OceanBase
OB_PASSWORD=... npm run oceanbase:export
```

For the current OceanBase Desktop install on macOS, the healthy database endpoint is inside the `oceanbase-desktop` OrbStack VM. The local Desktop tenant accepts VM-local `root` with an empty password, so the live load/export path is:

```bash
orb -m oceanbase-desktop -u root bash -lc '
  cd /Users/rogerlin/Downloads/chinashsr/ChinaHSR_Simulation &&
  OB_HOST=127.0.0.1 OB_PORT=2881 OB_USER=root OB_DATABASE=chinahsr \
    python3 scripts/migrate_12306_to_oceanbase.py \
      --load --allow-empty-password \
      --sqlite /Users/rogerlin/Downloads/chinashsr/12306.db \
      --create-database --truncate &&
  OB_HOST=127.0.0.1 OB_PORT=2881 OB_USER=root OB_DATABASE=chinahsr \
    python3 scripts/export_oceanbase_simulation_data.py --allow-empty-password
'
```

The runtime export uses the ordered `cr_12306_route_stations` stop contract for station order, but it no longer trusts every raw station coordinate or draws sparse station chords. It cross-checks `cr_12306_station_locations` against the generated station catalog and linked track anchors, then builds a coordinate-level graph from `cr_12306_railway_tracks` and `cr_12306_station_track_links`. In the current local export, 1,760 of 1,765 ordered station edges are traced over that OceanBase rail graph, 5 use bounded rail-corridor sampling, and 0 fall back to long ordered-stop straight lines. The geometry regression test also guards the known `嘉兴` coordinate issue, endpoint anchoring, >90 km hops, and visible backtracking hooks.

The generated dry-run artifacts are written under `exports/12306-oceanbase/` and ignored by git. The full database review and Tencent CVM deployment path live in [docs/12306-db-review.md](./docs/12306-db-review.md) and [docs/tencent-cvm-oceanbase-runbook.md](./docs/tencent-cvm-oceanbase-runbook.md).

### Python multiprocessing ETL

`scripts/oceanbase_seed.py` is a ~1,400-line Python ETL that:

1. **Reads** `public/route-data.json` and `public/station-data.json` (the same artifacts the browser uses).
2. **Partitions** the 365-day calendar into `chunk-days` chunks (default 8 days).
3. **Spawns** a `multiprocessing.Pool` with `CHINAHSR_WORKERS` workers (default = `min(CPU count, 12)`).
4. **Generates** per-route daily service counts, passenger estimates, and revenue estimates using the same calendar logic as the browser engine (holidays, peak seasons, weekends) — ensuring consistency between the live day and the annual plan.
5. **Batch-inserts** dimension tables once, then streams fact-table rows in `batch_size` chunks (default 4,000).

The whole year completes in **~2 seconds** on a 16-core MacBook Pro (with progress logging at 10% increments):

```
[oceanbase:seed] run=yearly-20260503T093240Z days=365 routes=1800 workers=12 chunk_days=8
[oceanbase:seed] connecting to OceanBase at 127.0.0.1:2881
[oceanbase:seed] loading dimension tables: 3,147 stations, 1,800 routes
[oceanbase:seed]   progress: 5/46 chunks (11%)
[oceanbase:seed]   progress: 10/46 chunks (22%)
...
[oceanbase:seed]   progress: 46/46 chunks (100%)
[oceanbase:seed] run=yearly-20260503T093240Z days=365 routes=1800 route_day_rows=657000
                 trains=8245069 passengers=3872435693 revenue=1493000206022.65
                 workers=12 db=loaded
```

### Calendar logic consistency

The Python script and the browser `SimulationEngine.js` share the **same holiday/peak calendar** so annual facts and live-day behaviour never diverge:

| Calendar event | Python `calendar_state()` | JS `calendarState()` |
|---|---|---|
| Weekend | `demand × 1.18, capacity × 1.08, price × 1.06` | identical |
| Spring Festival Chunyun (days 14–53) | `demand × 1.95, capacity × 1.52, price × 1.42` | identical |
| National Day golden week (days 274–281) | `demand × 1.86, capacity × 1.46, price × 1.38` | identical |
| Summer student peak (days 182–243) | `demand × 1.28, capacity × 1.16, price × 1.12` | identical |
| New Year travel surge (days 1–3) | `demand × 1.58, capacity × 1.34, price × 1.28` | identical |
| Qingming holiday (days 94–96) | `demand × 1.42, capacity × 1.24, price × 1.20` | identical |
| Labor Day golden week (days 121–125) | `demand × 1.72, capacity × 1.38, price × 1.34` | identical |
| Dragon Boat holiday (days 170–172) | `demand × 1.36, capacity × 1.18, price × 1.17` | identical |
| Year-end travel peak (days 354–365) | `demand × 1.20, capacity × 1.10, price × 1.08` | identical |

### Dashboard integration

The Dashboard reads the pre-generated `public/oceanbase-yearly-summary.json` (produced by the seed script with `--skip-db` for CI environments) and renders:

- Annual train services, passengers, and revenue
- OceanBase table row counts
- Calendar breakdown by holiday type
- Worker/core utilization

If the JSON is missing, the dashboard gracefully degrades to showing only live-day metrics.

### Configuration

```bash
cp .env.example .env
# Edit:
OB_HOST=127.0.0.1
OB_PORT=2881
OB_USER=root
OB_PASSWORD=your_oceanbase_tenant_password
OB_DATABASE=chinahsr
CHINAHSR_WORKERS=12
```

Run the seed:

```bash
OB_PASSWORD=... python3 scripts/oceanbase_seed.py
# Or dry-run (no DB, generates JSON only):
python3 scripts/oceanbase_seed.py --skip-db --days 30 --workers 4
```

### Indexing strategy

Every fact and dimension table carries explicit secondary indexes tuned for the queries that the dashboard and analyst notebooks actually execute:

```sql
-- routes: corridor + endpoint slicing
KEY idx_routes_corridor    (corridor)
KEY idx_routes_origin      (origin)
KEY idx_routes_destination (destination)

-- daily_route_services: time-series + per-route timeseries
KEY idx_daily_route_services_date       (service_date)
KEY idx_daily_route_services_route_date (route_id, service_date)

-- calendar_summary: filter by label (Spring Festival, National Day, etc.)
KEY idx_calendar_summary_label (calendar_label)
KEY idx_calendar_summary_date  (service_date)

-- bookings (live ledger): operator-facing queries
KEY idx_bookings_train      (train_id)
KEY idx_bookings_route_date (route_id, service_date)
KEY idx_bookings_status     (status)
KEY idx_bookings_run        (run_id)
```

Composite (`route_id`, `service_date`) indexes are critical for the most common analyst question — *"how did this route perform on this date range?"* — and let OceanBase return monthly route timelines in single-digit milliseconds even with all 657,000 fact-table rows.

### Idempotency, atomicity, and re-runs

- **Dimension tables** (`stations`, `routes`, `route_stops`, `route_segments`, `route_geometry`) all use `INSERT … ON DUPLICATE KEY UPDATE`. Re-running the seed against a populated cluster is safe and produces no duplicates.
- **`daily_route_services`** is wiped per `run_id` before insertion (`DELETE FROM daily_route_services WHERE run_id = %s`) so each `run_id` represents a clean snapshot. Different `run_id` values coexist for A/B comparisons (e.g., a baseline run and a what-if surge run side by side).
- **Inserts are batched** at `batch_size=4000` with explicit `conn.commit()` per batch. Failure after batch *n* leaves the first *n* batches durably persisted; the partial run can resume by re-issuing the same `run_id`.
- **`bookings`** uses `ON DUPLICATE KEY UPDATE` keyed on `ticket_id` so the same ticket can be inserted as `confirmed`, then later overwritten as `cancelled` or `noShow` without orphan rows.
- **Charset is `utf8mb4`** end-to-end so Chinese station names (`北京南`, `上海虹桥`, `重庆西`) round-trip without mangling — verified by the secret-scan sentinel and the `select * from routes where origin = '北京南'` query in the runbook below.

### Sample analytical queries

These run in single- or low-double-digit milliseconds against the populated `chinahsr` schema and back the dashboard tiles:

```sql
-- Top-10 corridors by annual passengers across all routes & runs
SELECT r.corridor,
       SUM(d.estimated_passengers) AS pax,
       SUM(d.estimated_revenue)    AS revenue
FROM   daily_route_services d
JOIN   routes r USING (route_id)
GROUP BY r.corridor
ORDER BY pax DESC LIMIT 10;

-- Day-by-day timeline for a specific route
SELECT service_date, service_count, demand_multiplier,
       estimated_passengers, estimated_revenue, calendar_label
FROM   daily_route_services
WHERE  run_id = 'yearly-...'
   AND route_id = 'route-12-D703'
ORDER  BY service_date;

-- Spring Festival vs Summer peak comparison
SELECT calendar_label,
       AVG(total_passengers) AS avg_pax,
       SUM(total_revenue)    AS total_revenue,
       COUNT(*)              AS day_count
FROM   calendar_summary
WHERE  run_id = 'yearly-...'
   AND calendar_label IN ('Spring Festival Chunyun',
                          'Summer student travel peak',
                          'National Day golden week')
GROUP  BY calendar_label;

-- Live booking pressure on a hub station today
SELECT origin_station,
       COUNT(*)           AS bookings,
       SUM(seat_count)    AS seats_sold,
       AVG(price)         AS avg_price,
       SUM(IF(no_show=1, seat_count, 0)) AS no_show_seats
FROM   bookings
WHERE  service_date = CURDATE()
GROUP  BY origin_station
ORDER  BY seats_sold DESC LIMIT 20;

-- Pull a route's geometry without leaving SQL
SELECT segment_index, geometry_source, coordinate_count,
       JSON_LENGTH(coordinates_json) AS json_len
FROM   route_geometry
WHERE  route_id = 'route-12-D703'
ORDER  BY segment_index;

-- Query the exact station order for a train's return route
SELECT rvs.stop_index,
       rvs.name,
       rvs.province,
       rvs.tier
FROM   route_variant_stops rvs
WHERE  rvs.route_variant_id = 'route-12-D703:return'
ORDER  BY rvs.stop_index;
```

### Operational runbook

```bash
# 1. Connect with OceanBase Desktop's MySQL-compatible client
obclient -h127.0.0.1 -P2881 -uroot -p   # password: your tenant pwd
mysql>  USE chinahsr;
mysql>  SHOW TABLES;
mysql>  SELECT COUNT(*) FROM daily_route_services;
mysql>  SELECT COUNT(*) FROM bookings;

# 2. Re-seed the year (idempotent)
OB_PASSWORD=... python3 scripts/oceanbase_seed.py --days 365 --workers 12

# 3. Replay an already-buffered NDJSON booking file
OB_PASSWORD=... python3 scripts/oceanbase_booking_ingest.py \
  --input /tmp/chinahsr-ledger/bookings-XXXXXXX.ndjson

# 4. CI-friendly dry-run (no DB writes, only summary JSON)
python3 scripts/oceanbase_seed.py --skip-db --days 30 --workers 4

# 5. Verify booking ledger ingest is wired live
curl -s http://127.0.0.1:5174/healthz
# → {"ok":true,"ledgerIngest":true,"ledgerDir":"/tmp/chinahsr-ledger"}

# 6. Force a manual ledger flush from the page
curl -s http://127.0.0.1:5174/ingest-bookings \
     -H 'Content-Type: application/x-ndjson' \
     --data-binary @some-bookings.ndjson
```

### Performance characteristics on OceanBase Desktop

Measured locally against OceanBase Desktop (single-tenant, 4 CPU, 8 GB RAM):

| Operation | Rows | Time | Throughput |
|---|---:|---:|---:|
| `chinahsr` schema bootstrap (14 `CREATE TABLE` statements) | — | < 100 ms | — |
| Dimension load (`stations` + routes/stops/segments/geometries + route variants + raw rail tracks) | ~72 K | ~1.5 s | ~48 K rows/s |
| Annual fact-table generation (Python multiprocessing) | 657 K | ~1.6 s | ~270 K rows/s |
| Annual fact-table insert (PyMySQL `executemany`, batch 4 K) | 657 K | ~7 s | ~62 K rows/s |
| `calendar_summary` upsert | 365 | ~70 ms | ~5 K rows/s |
| Top-10 corridor query | full year scan | ~12 ms | — |
| Per-route monthly timeline (covering index hit) | ~30 rows | < 2 ms | — |
| Live `bookings` upsert (one POST batch, ~50 entries) | ~50 | ~30 ms incl. process spawn | — |

The end-to-end `prepare:data` → `oceanbase:seed --days 365` cold path completes in **~13 s on a 12-core M-series MacBook Pro**.

### Why OceanBase specifically (vs MySQL/Postgres/SQLite)

- **HTAP-ready**: the same cluster serves OLTP-style live booking inserts and OLAP-style analyst queries without a separate warehouse.
- **MySQL wire-compatible**: PyMySQL, mysql-cli, and JDBC drivers all work unchanged. The schema and queries above run unmodified on MySQL 5.7 too.
- **Distributed-friendly**: although this project uses a single-tenant Desktop install, the same schema scales to a multi-zone OceanBase cluster — the partition-friendly `(run_id, day_index, route_id)` primary key on `daily_route_services` is already shape-correct for partition pruning at scale.
- **Provenance**: built and battle-tested by **Ant Group** for Alipay's transaction core. Demonstrating fluency with it is directly relevant to platform-engineering roles at Ant, Alibaba, and the broader Chinese cloud ecosystem.

### Role in the project

- **Persistence layer**: holds annual-scale aggregates that don't fit in the browser worker heap.
- **Analytical backend**: supports offline capacity planning, revenue forecasting, and what-if scenario analysis via SQL.
- **Booking system of record**: the `bookings` table (live-ingested) survives a browser refresh, page close, or worker crash — turning the simulation from a demo into a recoverable transactional system.
- **Enterprise DB demonstration**: distributed SQL, bulk loading, star-schema design, dimension/fact-table modelling, MySQL-compatible SQL, multiprocessing ETL, idempotent upserts, NDJSON streaming ingest, static server with fallback chains, and a runbook with measured performance numbers — directly relevant to large-scale platform engineering at **Ant Group**, **Alibaba**, and similar.

---

## Visualization layer

### Mapbox GL map (`HSRMap.jsx`)

| Layer | Style |
|---|---|
| `rails` | Width-interpolated cyan/blue line, opacity 0.58, zoom-scaled width 0.7 → 5 |
| `local-station-dots` | Tiny grey circles, radius 0.8 → 3 |
| `regional-station-squares` | Cyan `▪` glyph, halo, sized 8 → 17 |
| `national-station-diamonds` | Amber `◆` glyph, halo, sized 9 → 20 |
| `train-circles` | Color `interpolate(load, 0→#10b981, 0.72→#f59e0b, 0.95→#ef4444)`, radius `interpolate(load, 0→3.5, 1→8)` |
| `train-labels` | Train code, only at `zoom ≥ 7.2` to reduce visual clutter |

A single click on a train opens a Mapbox `Popup` with `code`, current/next station, load %, and `pax/capacity`.

### Operations dashboard (`Dashboard.jsx`)

Built with **Recharts**:

- 9-tile metric grid (revenue, passengers, active/total trains, visible-on-map, active avg delay, no-show releases, simulation thread, seat quota, trains/route)
- Speed slider (1×–480×, default 120×) wired to `worker.setSpeed` — 24 hours covered in ~3 minutes at max speed
- *Highest segment loads* bar chart (top 18 trains by load factor)
- *Recent booking revenue* monotonic line chart
- *Station platform pressure* dual bar chart (active trains × passengers)
- *Operational realism* tile (station stops, ≥ 3-min delays, no-show releases, map-render cap)
- *Corridor coverage* + *Origin-province coverage* bar charts
- Live train operations table (40 rows, `<meter>` element for load)

### Booking panel (`BookingPanel.jsx`)

Two-column form-and-quote panel:

- Train / origin / destination / class / preference / accessible-seat dropdowns
- Live `quoteTrip` debounced to selection changes
- Quote card shows price, distance, available seats, **multipliers grid** (`scarcity`, `timePressure`, `peak`, `frequencyRelief`, `noShowBuffer`), and `algorithmMs`
- Visual *seat strip* highlighting the held interval across the route
- "Book Ticket" button posts `bookTrip` through the worker
- Recent ticket list with `ticketId`, train code, OD, car-row-letter, and price

---

## Testing strategy

The test pyramid is intentionally flat — fast, deterministic, scenario-driven:

```
tests/
├── seatInventory.test.mjs        ← seat reuse / overlap rejection / interval timeline
├── pricing.test.mjs              ← class ordering / scarcity monotonicity / surge
├── engine.test.mjs               ← end-to-end booking, scaled scheduling,
│                                    no-show release, live-demand revenue motion,
│                                    full-year day rollover, train monotonic movement,
│                                    terminal return trips
├── dataDiversity.test.mjs        ← ≥1000 routes, ≥70 origins, ≥24 provinces,
│                                    ≥20 corridors, ≥85% rail-matched segments,
│                                    ≥50% rail-traced (graph-followed),
│                                    Xi'an coverage regression
├── scenarios.test.mjs            ← disruption one-time slowdown + expiry,
│                                    demand-surge lift + expiry,
│                                    deterministic auto-disturbances,
│                                    hourly demand shape, cancellation accounting,
│                                    delay-cascade propagation
├── geometryValidation.test.mjs   ← segment continuity (0 boundary breaks),
│                                    endpoint anchoring, no long direct shortcuts,
│                                    rail-traced polyline density,
│                                    OSM augmentation regression for missing hubs,
│                                    route deduplication audit, long-route hub preference
├── bookingLedger.test.mjs        ← every booking captured with rich metadata,
│                                    cancellations append status=cancelled,
│                                    OceanBase ingest dry-run skips malformed rows
├── oceanbaseRouteGeometry.test.mjs
│                                  ← OceanBase 12306 export repairs bad station
│                                    coordinates and rejects long chords,
│                                    >90 km hops, backtracking hooks,
│                                    rail-track geometry without zigzags
├── oceanbaseSeed.test.mjs        ← 30-day OceanBase dry-run produces uncapped totals
└── 12306Migration.test.mjs       ← 12306 SQLite → OceanBase migration dry-run emits
│                                    review manifest and queryable route schema,
│                                    ordered stops and return route contract preserved
```

Each test is `node:test` ESM with `assert/strict`. The whole suite runs in **~1.1 seconds** on a modern laptop. Every test asserts behaviour the user can observe in the UI — so green tests really mean *"the feature works"*.

Run them locally:

```bash
npm test
```

Sample output:

```
✔ 12306 OceanBase migration dry-run emits review manifest and queryable route schema
✔ 12306 simulation export preserves ordered stops and return route contract
✔ booking ledger captures every confirmed booking with rich metadata
✔ cancellations append a status=cancelled ledger entry
✔ OceanBase booking ingest dry-run validates rows and skips malformed ledger entries
✔ generated route database covers many corridors and origins
✔ booking engine returns ticket details and mutates interval availability
✔ engine creates scalable scheduled services and full booking options
✔ calendar starts on January 1 and applies route-level surge service planning
✔ engine rolls detailed services forward across the full-year calendar
✔ train movement is monotonic and processes every crossed station once
✔ train reverses at the terminal and returns through the same stations in reverse order
✔ no-show passengers release their seat inventory after departure
✔ live demand changes revenue and passenger totals during ticks
✔ every route segment connects continuously to the next
✔ segment geometry is anchored to station endpoints and avoids long direct shortcuts
✔ rail-traced segments have plausible polyline density
✔ OSM augmentation surfaces national hubs missing from station CSV
✔ long routes prefer hub stations on actual HSR mainline (no local coastal halts)
✔ route deduplication keeps OD pairs roughly unique per direction
✔ every generated route has an ordered outbound and return route contract
✔ OceanBase 12306 export follows rail-track geometry without coordinate zigzags
✔ OceanBase annual generator produces uncapped route-day summary without database credentials
✔ dynamic pricing orders seat classes and rises with scarcity
✔ same seat is reusable after passenger alights but blocked for overlapping intervals
ℹ tests 32
ℹ pass  32
ℹ fail  0
```

---

## Project structure

```
ChinaHSR_Simulation/
├── README.md                          ← this file
├── README.zh-CN.md                    ← Chinese mirror
├── run.sh / run.cmd                   ← one-shot launchers
├── init.sh                            ← original developer harness
├── package.json
├── vite.config.js
├── index.html
├── feature_list.json                  ← spec-as-data, every feature passing
├── handoff.md                         ← decisions & verification log
├── PLANS.md                           ← active design slices and verification plan
├── agent-progress.txt                 ← session-by-session changelog
├── .env.example                       ← template for secrets (not committed)
├── public/                            ← committed data artifacts
│   ├── station-data.json   (3,147 stations)
│   ├── route-data.json     (1,800 routes + 7,278 records)
│   ├── oceanbase-yearly-summary.json
│   ├── oceanbase-simulation-data.json
│   ├── hsr-stations.geojson
│   └── hsr-rails.geojson   (12,000 OSM rail features)
├── scripts/
│   ├── prepare-data.cjs               ← ETL pipeline (§8)
│   ├── oceanbase_seed.py              ← OceanBase 365-day aggregate loader
│   ├── oceanbase_booking_ingest.py    ← live booking ledger NDJSON → OceanBase
│   ├── export_oceanbase_simulation_data.py  ← runtime route export from OceanBase
│   ├── migrate_12306_to_oceanbase.py  ← SQLite 12306 → OceanBase migration
│   └── serve-static.cjs               ← zero-dep Node http server + API backend
├── src/
│   ├── main.jsx                       ← React 19 root
│   ├── App.jsx                        ← view switcher, worker bootstrap, delta merge
│   ├── algorithms/
│   │   ├── seatInventory.js           ← interval calendar (§5.1)
│   │   └── pricing.js                 ← yield management (§5.2)
│   ├── simulation_core/
│   │   ├── SimulationEngine.js        ← DES core (§5.3)
│   │   ├── simulationWorker.js        ← Web Worker handlers (§5.9, §7)
│   │   ├── SimulationWorkerClient.js  ← promise-based message bus (§7)
│   │   └── geo.js                     ← haversine + polyline interpolation
│   ├── visualization/
│   │   ├── HSRMap.jsx
│   │   ├── Dashboard.jsx
│   │   └── BookingPanel.jsx
│   └── styles/app.css
├── tests/                             ← deterministic regression suite (32 tests)
│   ├── seatInventory.test.mjs
│   ├── pricing.test.mjs
│   ├── engine.test.mjs
│   ├── dataDiversity.test.mjs
│   ├── scenarios.test.mjs
│   ├── geometryValidation.test.mjs
│   ├── bookingLedger.test.mjs
│   ├── oceanbaseRouteGeometry.test.mjs
│   ├── oceanbaseSeed.test.mjs
│   └── 12306Migration.test.mjs
├── screenshots/                       ← marketing screenshots (this README)
├── docs/
│   ├── 12306-db-review.md
│   └── tencent-cvm-oceanbase-runbook.md
└── exports/                           ← generated artifacts (gitignored)
    └── 12306-oceanbase/
```

---

## Configuration & secret handling

> **Required first step:** the map view needs a public Mapbox token at build time. Without it, the map tab shows a clear "token not configured" panel with copy-paste setup instructions, and the Dashboard / Booking tabs still work. Public Mapbox tokens (`pk.…`) are safe to ship in client-side code as long as they don't carry secret scopes.

```bash
cp .env.example .env
# edit .env and set at minimum:
VITE_MAPBOX_TOKEN=pk.your_public_token
VITE_MAPBOX_STYLE=mapbox://styles/your-account/your-style-id   # or mapbox/dark-v11

# optional — enables OceanBase persistence + live booking ledger ingest:
OB_PASSWORD=your_local_oceanbase_password
CHINAHSR_PYTHON=/path/to/python3      # if your default python3 doesn't have PyMySQL

# rebuild so Vite injects the token into the bundle
npm run build && npm run serve
```

Build-time secret scan (run by `init.sh`):

```bash
rg "sk\.ey" .   # must produce no matches; secret-scoped tokens never enter the repo
```

---

## Tech stack

- **React 19.2** with hooks (`useEffect`, `useMemo`, `useRef`, `useCallback`, `useState`)
- **Vite 8** + `@vitejs/plugin-react` for ESM dev server and Rollup-powered code-splitting
- **Mapbox GL JS 3.x** for raster + vector + symbol layers and zoom-interpolated styles
- **Recharts 3.x** for `BarChart`, `LineChart` with `ResponsiveContainer`
- **Web Workers (`type: 'module'`)** for off-main-thread simulation
- **`node:test` + `assert/strict`** for the regression suite (zero test-runner dependency)
- **lucide-react** icons
- **seedrandom / FNV-1a** for deterministic RNG
- **PapaParse** (transitively) — CSV parser was hand-rolled in `prepare-data.cjs` to keep the pipeline dependency-free

---

## Roadmap

- [ ] Algorithm comparison page: ILP / MILP exact small-instance optimization vs. the production heuristic, with side-by-side load factor & revenue charts.
- [ ] Scenario export/replay: serialize seed + demand profile to a JSON file, replay deterministically anywhere.
- [ ] Authoritative timetable ingestion: when a stop-by-stop China Railways timetable becomes available, drop in the full schedule and remove the `simulatedStop` flag.
- [ ] WebGPU compute shader only for a future regular numeric kernel; current annual planning is branch-heavy and is faster/safer as CPU multiprocessing plus OceanBase bulk I/O.
- [ ] WebSocket multi-client demo: multiple browsers booking against the same shared engine running in a Node.js worker pool.
- [ ] Internationalisation pass (i18n strings extracted; CN labels are currently hard-coded next to EN).

---

## Disclaimer & data provenance

This is **not an official China Railways product**, and it does not connect to or replicate the 12306 production system. It is a research-grade simulation built from publicly available datasets:

- **Station list** — `China-rail-way-stations-data-main` (community-maintained Chinese railway stations CSV with WGS-84 coordinates).
- **Train origin/destination records** — same dataset's `line.csv`, real G/D/C train OD pairs, but **without** stop-by-stop timetables. Intermediate stops are *simulation-derived* from geographically plausible stations between real endpoints, and every generated stop is labelled `simulatedStop: true`.
- **Rail geometry** — [HOTOSM Chinese railways](https://data.humdata.org/dataset/hotosm_chn_railways) (LineString and Point GeoJSONs) under the [Open Database License](https://www.openstreetmap.org/copyright).

Every generated artifact carries a `provenance` field. The simulator is open about which numbers are real (origin, destination, total distance), which are heuristically derived (intermediate stops, segment distances, segment speed limits, dwell times), and which are randomized (no-show events, weather drag, dispatch slack) — all inside a deterministic seeded RNG so demos are reproducible.

---

## License

[MIT](LICENSE) © 2026 Roger Lin

---

> If you're a hiring manager or recruiter from **Ant Group, Alibaba, Tencent, Baidu, Huawei** (or anywhere else really), I'd love to walk you through the design choices in this codebase. Reach out via the [GitHub profile](https://github.com/linroger).
