# China HSR Simulation — Performance & Bottleneck Audit

**Audited:** 2026-05-14  
**Method:** Micro-benchmarks, heap profiling, component size analysis, algorithmic complexity review  
**Test Hardware:** MacBook Pro (M-series), Node v25.2.1, 6000-train configuration

---

## 1. Executive Summary

The simulation runs at **~20 ticks/second** and publishes **12.2 MB snapshots every 150 ms** from the Web Worker to the main thread. That is **~82 MB/s of JSON churn** — the single biggest bottleneck. Other critical hotspots include:

- **Snapshot creation:** 24 ms (just building the object) + 29 ms `JSON.stringify` = **53 ms per publish**
- **Booking options bloat:** 9.07 MB (74% of snapshot) — every train embeds a full `stops` array even though trains on the same route share identical stops
- **Dashboard re-render:** Sorts 1,500 trains and rebuilds cumulative revenue series on **every frame**
- **Worker init:** 834 ms engine init + 6,751 ms demand preload = **7.6 seconds before first paint**
- **Tick spikes:** Average 0.8 ms but p95 = 3.1 ms, max = 9.0 ms — occasional frame drops

**Production readiness:** The app will stutter and consume excessive memory at the 6,000-train scale. Browser tabs will likely crash on lower-end devices.

---

## 2. Benchmark Raw Data

| Metric | Value | Budget / Context |
|--------|-------|------------------|
| Engine init (no preload) | **834 ms** | Blocks worker thread |
| Demand preload | **6,751 ms** | 2.73M passengers, 733k bookings |
| Tick avg (0.05s @ speed=60) | **0.80 ms** | 50 ms loop budget |
| Tick p95 | **3.12 ms** | 6% of budget |
| Tick max | **9.05 ms** | 18% of budget — causes frame drops |
| Snapshot creation | **24.4 ms** | 16% of 150 ms publish interval |
| `JSON.stringify` snapshot | **29.4 ms** | 20% of publish interval |
| Snapshot size | **12.23 MB** | Transferred every 150 ms |
| `createBookingOptions` | **2.12 ms** | Runs on every dirty snapshot |
| `selectVisibleTrains` (×100) | **26.5 ms** | 0.27 ms per call — fast |
| `networkSummary` (×100) | **16.7 ms** | 0.17 ms per call — fast |
| Quote latency | **10.4 μs** | Negligible |
| `processStation` (128 bookings) | **0.001 ms** | Negligible |
| Worker bundle size | **35 KB** | Good |
| Main bundle size | **2.2 MB** | Heavy (includes Mapbox + Recharts) |
| `route-data.json` | **14.2 MB** | Downloaded on init |
| `hsr-rails.geojson` | **4.8 MB** | Uploaded to Mapbox GPU |

---

## 3. Web Worker ↔ Main Thread Bottleneck

### 3.1 The 12-MB Snapshot Problem

The worker calls `engine.snapshot()` every **150 ms** and `postMessage`s the result. On a 6,000-train day the snapshot breaks down as:

| Component | Size | % of Total | Redundant? |
|-----------|------|------------|------------|
| `bookingOptions` | **9.07 MB** | 74% | **Yes** — every option embeds full `stops` array |
| `trains` | **3.14 MB** | 26% | Partial — `stops` arrays duplicated per train |
| `events` | 9.9 KB | <0.1% | No |
| `bookings` | 10.4 KB | <0.1% | No |
| `network` | 4.9 KB | <0.1% | No |
| `stats` | 0.8 KB | <0.1% | No |
| `calendar` | 0.3 KB | <0.1% | No |

**Root cause:** `snapshot()` serializes **all 6,000 booking options**, and each option carries the full `stops` array (~630 bytes × 7 stops ≈ 4.4 KB per option). With 1,200 unique routes and 6,000 trains, the same route stops are repeated **~5× on average**.

**Impact:**
- `postMessage` uses **structured clone**, which is slower than `JSON.stringify` for deep plain objects.
- Estimated total worker-side cost per publish: **50–80 ms** (snapshot + clone + post).
- Main thread must **deserialize** 12 MB into new object trees, triggering major GC pauses.
- React then re-renders the entire tree, diffing against 12 MB of fresh props.

### 3.2 Booking Options Are Almost Never Needed

`includeBookingOptions` is `true` only on `init`, `booking`, `manual`, or day-boundary snapshots. Yet the benchmark shows `bookingOptions` is present in a routine `tick` snapshot:

```javascript
// simulationWorker.js:81
const includeBookingOptions = reason === 'init' || reason === 'booking' || reason === 'manual' || serviceDayIndex !== lastPublishedServiceDayIndex;
```

At startup, `serviceDayIndex` starts at `0`. The first `tick` snapshot sets `lastPublishedServiceDayIndex = 0`. On the **second** tick, `serviceDayIndex === lastPublishedServiceDayIndex`, so `includeBookingOptions` should be `false`.

But `postSnapshot('preload')` and `postSnapshot('preload-complete')` are also sent during background preload. Each of these snapshots includes the full 9 MB booking options because `reason !== 'init/booking/manual'` but `serviceDayIndex !== lastPublishedServiceDayIndex` is true on the first preload snapshot.

**During the 6.75-second preload**, dozens of 9-MB snapshots are posted. That’s ~300–500 MB of redundant data transfer before the user even sees the map.

### 3.3 Recommendation: Delta Snapshots + Route Lookup

**Option A (quick win):** Remove `stops` from `bookingOptions`. Send a `routesById` lookup table once at init. Booking options only need `routeId` + `stopIndexes`.

**Option B (better):** Switch from full snapshots to **delta snapshots**. Only send trains whose state changed since last publish. With 663 active trains and only a few dozen changing per tick, a delta would be **<50 KB** instead of 12 MB.

**Option C (best):** Use **Transferable Objects** for the snapshot buffer. Serialize to a compact binary format (flat arrays of floats + ints) and transfer the ArrayBuffer. This avoids structured clone overhead entirely.

---

## 4. Simulation Engine Hot Paths

### 4.1 `snapshot()` Serializes All 6,000 Trains

```javascript
// SimulationEngine.js:574-577
const serialized = this.trains.map((train) => serializeTrain(train, this.nowMinutes));
const visibleTrains = selectVisibleTrains(serialized, SNAPSHOT_TRAIN_LIMIT);
```

`serializeTrain` is called for **all 6,000 trains**, but `selectVisibleTrains` only keeps 1,500. The other 4,500 are serialized and immediately discarded.

**Cost:** ~16 ms of the 24 ms snapshot time is wasted on trains that will be filtered out.

**Fix:** Filter to visible candidates *before* serialization. Only serialize the ~1,500–2,000 trains that are active, scheduled within 120 min, or recently completed.

### 4.2 `serializeTrain` Embeds Full `stops` Array

Every serialized train includes:
```javascript
stops: train.stops.map((stop, index) => ({ ...stop, index })),
```

This creates **7 new objects per train** × 1,500 visible trains = **10,500 objects** per snapshot.

**Fix:** Send `stopIndexes` instead of full stop objects, or send stops in a shared lookup table.

### 4.3 `advanceServiceDay` is a Stop-the-World Event

When the clock crosses midnight:
1. All 6,000 train objects are discarded.
2. New 6,000 trains are created (`createScheduledServices`).
3. Seat inventories are rebuilt (`new SeatInventory` × 6,000).
4. `preloadDemand` runs again (6.75 seconds of blocking work).

**Impact:** The UI freezes for **~7+ seconds** at every day boundary. On speed=60, a day is 24 real minutes. So the user experiences a 7-second freeze every 24 minutes.

**Fix:** Pre-schedule trains for the next day in the background and hot-swap the array at the boundary. Keep the old day's trains for a short grace period to finish in-flight bookings.

### 4.4 `createBookingOptions` Maps All 6,000 Trains

```javascript
// SimulationEngine.js:621-642
return this.trains.map((train) => ({ ...stops: train.stops.map(...) }));
```

Called whenever `bookingOptionsDirty` is true (after every booking, turnaround, or day advance).

**Fix:** Cache booking options by `routeId`. Trains on the same route share the same option shape except for `id`, `departureMinute`, and `serviceIndex`.

### 4.5 `processStation` Scales Linearly with Bookings

```javascript
// SimulationEngine.js:374-401
for (const booking of train.bookings) {
  if (booking.originIndex === stationIndex && booking.status === 'confirmed') { ... }
  if (booking.destinationIndex === stationIndex && booking.status === 'onboard') { ... }
}
```

While the benchmark shows 0.001 ms for 128 bookings, this is because the global `this.bookings` cap of 400 limits per-train retention. If the cap were raised or if bookings were preserved, this would become a major bottleneck.

**Fix:** Maintain `bookingsByOriginStation` and `bookingsByDestinationStation` indexes.

### 4.6 `sellRealtimeDemand` Filters Bookable Trains Every 6th Tick

```javascript
const bookable = this.trains.filter((train) => !train.completed && train.departureMinute > this.nowMinutes - 20);
```

This scans all 6,000 trains. At 20 Hz, this runs ~3.3 times/second.

**Fix:** Maintain a `bookableTrains` index that updates only when train status changes.

---

## 5. Frontend Rendering Bottlenecks

### 5.1 `Dashboard.jsx` Sorts 1,500 Trains on Every Render

```javascript
const topLoads = trains.slice().sort((a, b) => b.loadFactor - a.loadFactor).slice(0, 18);
```

`trains` array is replaced with a new reference on every snapshot (every 150 ms). React re-renders `Dashboard`. `topLoads` is recomputed with an **O(n log n) sort** of 1,500 items.

**Cost:** ~0.5–1.0 ms per render. At 6–7 renders/second, this adds up.

**Fix:** Memoize with `useMemo` keyed by a hash of load factors, or only recompute when `trains.length` or `totalPassengers` changes.

### 5.2 `buildRevenueSeries` Rebuilds Cumulative Totals on Every Render

```javascript
function buildRevenueSeries(bookings) {
  let total = 0;
  return bookings.slice().reverse().map((booking, index) => {
    total += booking.price;
    return { label: `${index + 1}`, revenue: total };
  });
}
```

Runs on every render. With 12 bookings, this is trivial. But if the cap is raised, this becomes expensive.

**Fix:** Memoize with `useMemo`.

### 5.3 `HSRMap.jsx` Uploads GeoJSON to Mapbox Every 32 ms

```javascript
if (timestamp - lastRenderRef.current >= 32 || progress >= 1) {
  mapRef.current.getSource('trains').setData(trainGeojson(rendered));
  lastRenderRef.current = timestamp;
}
```

During the 190 ms animation transition, `setData` is called up to **6 times**, uploading a GeoJSON FeatureCollection with up to 850 features to the GPU.

**Mapbox `setData` cost:** For 850 points, this is ~1–2 ms per call. 6 calls = ~10 ms per transition.

**Fix:** Use Mapbox's `custom layer` or `deck.gl` for GPU-driven animation instead of CPU-side GeoJSON updates.

### 5.4 `BookingPanel.jsx` Re-Quotes on Every Booking

```javascript
useEffect(..., [quoteTrip, selectedTrain?.id, originIndex, safeDestinationIndex, seatClass, snapshot.stats.totalBookings]);
```

The dependency on `snapshot.stats.totalBookings` causes a **quote refresh every time any booking is made anywhere in the network**.

**Fix:** Remove `totalBookings` from deps. Only re-quote when the trip parameters change.

### 5.5 `App.jsx` `mergeSnapshot` Creates Shallow Copies

```javascript
function mergeSnapshot(previous, nextSnapshot) {
  if (!previous || nextSnapshot.bookingOptions) return nextSnapshot;
  return { ...nextSnapshot, bookingOptions: previous.bookingOptions };
}
```

This spreads `nextSnapshot` into a new object on every render. React sees a new reference and re-renders the entire app tree.

**Fix:** Use `React.memo` on `Dashboard`, `HSRMap`, and `BookingPanel` with deep comparison or stable keys.

---

## 6. Data Pipeline & Build Bottlenecks

### 6.1 `prepare-data.cjs` Memory Peak

The ETL:
1. Parses 347k OSM rail LineStrings into a 254k-node graph
2. Runs Dijkstra/A* for 7,338 segments
3. Simplifies and caps geometries

**Memory peak:** Estimated **500–800 MB** during graph construction. The script has no memory-conscious streaming — it loads the entire OSM GeoJSON into memory.

**Fix:** Stream-parse the GeoJSON using a SAX parser, or pre-filter rail features by bounding box before loading.

### 6.2 `route-data.json` is 14.2 MB

Downloaded by the browser on init. On slow connections, this adds seconds to first paint.

**Fix:** Compress with gzip (would drop to ~2–3 MB). Vite's dev server serves gzipped assets in production, but the static server (`serve-static.cjs`) does not implement gzip.

### 6.3 Main Bundle is 2.2 MB (Uncompressed)

Includes Mapbox GL (~800 KB) and Recharts (~400 KB). No code splitting by route/view.

**Fix:** Lazy-load `Dashboard` and `BookingPanel` with `React.lazy()`. The map view should load first.

### 6.4 `serve-static.cjs` Serves Uncompressed JSON

```javascript
fs.createReadStream(filePath).pipe(response);
```

No gzip/deflate compression for JSON or GeoJSON assets.

**Fix:** Add `zlib.createGzip()` pipeline for `.json` and `.geojson` files.

---

## 7. Python / OceanBase Performance

### 7.1 `export_oceanbase_simulation_data.py` Spawns Per Request

Every `GET /api/oceanbase-simulation-data` spawns a **new Python process** with a **new DB connection**.

**Cost:** ~200–500 ms per request (connection + query + JSON build).

**Fix:** Cache the export in memory for the 60-second TTL. Do not spawn Python if the cache is warm.

### 7.2 `oceanbase_seed.py` Multiprocessing Anti-Pattern

```python
conn = connect_oceanbase(...)
# ... long MP computation ...
generate_and_optionally_insert_daily_rows(conn=conn, ...)
```

The DB connection is held open but **idle** during multiprocessing. If `wait_timeout` is short, the connection drops before insertion.

**Fix:** Open the connection **after** MP computation, not before.

### 7.3 `bulk_execute` Commits After Every Batch

```python
cursor.executemany(sql, rows[start:start + batch_size])
conn.commit()  # <-- every batch!
```

For 438k rows at batch_size=5,000, this is **88 commits**. Each commit forces a WAL flush.

**Fix:** Commit every 5–10 batches.

---

## 8. Memory Usage Analysis

### 8.1 Worker Heap Churn

Per snapshot, the engine creates:
- ~6,000 serialized train objects
- ~6,000 booking option objects
- ~42,000 stop objects (inside booking options)
- ~10,500 stop objects (inside visible trains)
- ~80 event objects
- ~12 booking objects

Total: **~64,000 new objects every 150 ms** = **427,000 objects/second**.

The JS engine's GC must clean these up constantly. On lower-end devices, this causes **GC pauses** that manifest as jank.

### 8.2 Main Thread Heap Churn

React receives the 12 MB snapshot and builds a new VDOM tree. The old snapshot and VDOM are discarded. This doubles the peak heap pressure to **~24–30 MB** of transient objects per frame.

### 8.3 Mapbox GPU Memory

- `hsr-rails.geojson`: 4.8 MB → uploaded as GPU buffers (~15–20 MB GPU memory)
- `hsr-stations.geojson`: 673 KB → ~2 MB GPU memory
- Train source: 850 features × ~200 bytes = ~170 KB, updated 6× per transition

Total GPU memory: **~20–25 MB**. Acceptable, but train source updates cause GPU command buffer churn.

---

## 9. Priority Optimization Roadmap

| Priority | Optimization | Expected Impact | Effort |
|----------|-------------|-----------------|--------|
| **P0** | **Delta snapshots** — only send changed trains | **12 MB → ~50 KB** (240× reduction) | 4–6 hrs |
| **P0** | **Remove `stops` from bookingOptions** — use route lookup table | **9 MB → ~0.5 MB** | 2 hrs |
| **P0** | **Memoize Dashboard sorts & revenue series** | Eliminates O(n log n) per render | 30 min |
| **P0** | **Debounce BookingPanel quote refresh** | Eliminates excess worker round-trips | 30 min |
| **P1** | **Filter before serialize** in `snapshot()` | Saves ~16 ms per publish | 1 hr |
| **P1** | **Background day scheduling** | Eliminates 7-second freeze at midnight | 4–6 hrs |
| **P1** | **Gzip static assets** in `serve-static.cjs` | 14 MB → ~3 MB | 30 min |
| **P1** | **Batch DB commits** in Python scripts | 10× faster bulk loads | 1 hr |
| **P2** | **Lazy-load Dashboard & BookingPanel** | Faster initial paint | 1 hr |
| **P2** | **GPU-driven train animation** | Eliminates GeoJSON upload churn | 4–8 hrs |
| **P2** | **Preload demand in chunks with yields** | Smoother init, responsive UI sooner | 2 hrs |
| **P3** | **Binary snapshot format** (flat buffers) | Eliminates structured clone overhead | 1–2 days |

---

*End of performance audit. Recommend starting with P0 delta snapshots — it provides the largest relief for the smallest effort.*
