# China HSR Simulation — Implementation Improvements Roadmap

**Scope:** Performance, efficiency, correctness, realism, and dynamic behavior enhancements  
**Based on:** `COMPREHENSIVE_BUG_AUDIT.md` and `PERFORMANCE_AUDIT.md`  
**Target:** Production-ready simulation with sub-second init, 60 FPS rendering, and realistic operational dynamics

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [P0 Critical Fixes (Do First)](#2-p0-critical-fixes-do-first)
3. [P1 Performance & Efficiency](#3-p1-performance--efficiency)
4. [P2 Simulation Realism & Dynamics](#4-p2-simulation-realism--dynamics)
5. [P3 Data Pipeline Hardening](#5-p3-data-pipeline-hardening)
6. [P4 Frontend Polish](#6-p4-frontend-polish)
7. [Implementation Order](#7-implementation-order)

---

## 1. Architecture Overview

The current architecture has three fundamental bottlenecks that must be addressed before any polish work:

1. **Monolithic snapshots** — The worker ships 12 MB of JSON every 150 ms. The fix is delta snapshots.
2. **Synchronous day transitions** — `advanceServiceDay()` blocks for 7+ seconds. The fix is pre-scheduling.
3. **Redundant stop embedding** — Every train and booking option carries a full `stops` array. The fix is route-level deduplication.

These three changes alone will reduce worker→main thread bandwidth by **~95%**, eliminate UI freezes, and cut snapshot creation time from **24 ms to ~3 ms**.

---

## 2. P0 Critical Fixes (Do First)

### 2.1 Delta Snapshots — Reduce 12 MB to ~50 KB

**Problem:** `snapshot()` serializes the entire simulation state every 150 ms. 74% of the payload is `bookingOptions` which rarely change.

**Solution:** Implement a delta protocol. Only send trains whose state changed since the last publish, plus a compact routing table for stops.

**Implementation:**

```javascript
// In SimulationEngine.js, replace snapshot() with deltaSnapshot()
deltaSnapshot(previousSnapshot = null) {
  const changedTrains = [];
  const nowMinutes = this.nowMinutes;
  
  for (const train of this.trains) {
    const prev = previousSnapshot?.trainById?.get(train.id);
    const next = serializeTrainMinimal(train, nowMinutes);
    
    if (!prev || trainChanged(prev, next)) {
      changedTrains.push(next);
    }
  }
  
  return {
    nowMinutes,
    calendar: this.calendar,
    stats: this.stats,
    events: this.events.slice(0, 20), // only new events
    trains: changedTrains,
    bookingOptions: this.bookingOptionsDirty ? this.createBookingOptions() : undefined,
    network: this.networkDirty ? networkSummary(this.trains) : undefined,
  };
}

function serializeTrainMinimal(train, nowMinutes) {
  // Only fields that change every tick
  return {
    id: train.id,
    status: train.status,
    currentSegmentIndex: train.currentSegmentIndex,
    segmentProgress: train.segmentProgress,
    routeProgress: train.routeProgress,
    journeyProgress: train.journeyProgress,
    coords: interpolateTrainCoords(train),
    passengerCount: train.inventory.occupancyForSegment(train.currentSegmentIndex).occupied,
    loadFactor: train.inventory.occupancyForSegment(train.currentSegmentIndex).loadFactor,
    currentDelayMinutes: currentDelay(train),
    minutesToDeparture: Math.round(train.departureMinute - nowMinutes),
  };
}

function trainChanged(a, b) {
  return a.status !== b.status
    || a.currentSegmentIndex !== b.currentSegmentIndex
    || Math.abs(a.segmentProgress - b.segmentProgress) > 0.001
    || Math.abs(a.loadFactor - b.loadFactor) > 0.01;
}
```

**Worker-side integration:**
```javascript
// simulationWorker.js
let lastSnapshot = null;

function postSnapshot(reason) {
  const snapshot = engine.deltaSnapshot(lastSnapshot);
  lastSnapshot = snapshot; // cache for next delta
  self.postMessage({ type: 'snapshot', reason, snapshot });
}
```

**Main thread integration:**
```javascript
// SimulationWorkerClient.js
handleMessage(message) {
  if (message.type === 'snapshot') {
    // Merge delta into full state
    this.fullState = mergeDelta(this.fullState, message.snapshot);
    this.onSnapshot?.(this.fullState);
  }
}
```

**Expected impact:** 12 MB → 50–200 KB (60–240× reduction). Snapshot creation drops from 24 ms to ~3 ms.

---

### 2.2 Route-Level Stop Deduplication

**Problem:** `bookingOptions` embeds full `stops` arrays for all 6,000 trains. Trains on the same route share identical stops.

**Solution:** Send stops once per route, and reference them by `routeId`.

```javascript
// In snapshot()
const routesById = new Map();
for (const train of this.trains) {
  if (!routesById.has(train.routeId)) {
    routesById.set(train.routeId, {
      stops: train.stops.map((stop, index) => ({ ...stop, index })),
      segments: train.segments, // if needed by map
      totalDistanceKm: train.totalDistanceKm,
    });
  }
}

return {
  ...snapshot,
  routes: Object.fromEntries(routesById),
  trains: this.trains.map(t => ({
    ...t,
    routeId: t.routeId, // client looks up stops in snapshot.routes[t.routeId]
    stops: undefined,   // removed!
  })),
};
```

**Client-side:**
```javascript
// HSRMap.jsx / Dashboard.jsx
const trainStops = snapshot.routes[train.routeId]?.stops || [];
```

**Expected impact:** Booking options shrink from 9 MB to ~0.5 MB. Train arrays shrink from 3 MB to ~1.5 MB.

---

### 2.3 Pre-Schedule Service Days (Eliminate 7-Second Freeze)

**Problem:** `advanceServiceDay()` creates 6,000 trains synchronously, then runs 6.75 seconds of preload demand. The UI freezes.

**Solution:** Build the next day's trains in a background microtask, then hot-swap at midnight.

```javascript
// SimulationEngine.js
constructor(...) {
  this.nextDayTrains = null;
  this.nextDayPreloadCursor = 0;
  this.scheduleNextDay(); // start building tomorrow in background
}

advanceServiceDay(calendar) {
  // Hot-swap to pre-built trains
  if (this.nextDayTrains) {
    this.trains = this.nextDayTrains;
    this.trainById = new Map(this.trains.map(t => [t.id, t]));
    this.nextDayTrains = null;
  } else {
    // Fallback: build synchronously if background didn't finish
    this.trains = this.createScheduledServices(this.routes, this.dailyTrainBudget, calendar);
    this.trainById = new Map(this.trains.map(t => [t.id, t]));
  }
  
  this.bookingOptions = this.createBookingOptions();
  this.preloadCursor = 0;
  this.stats.cumulativeTrainServices += this.trains.length;
  
  // Start building the day after next in background
  const nextCalendar = calendarState((calendar.dayIndex + 2) * 1440);
  this.scheduleNextDay(nextCalendar);
}

scheduleNextDay(calendar) {
  if (!calendar) calendar = calendarState((this.calendar.dayIndex + 2) * 1440);
  this.nextDayTrains = this.createScheduledServices(this.routes, this.dailyTrainBudget, calendar);
  this.nextDayPreloadCursor = 0;
  // Preload demand in chunks via setTimeout so it doesn't block
  this.preloadNextDayInChunks();
}

preloadNextDayInChunks(batchSize = 80) {
  if (!this.nextDayTrains) return;
  let processed = 0;
  while (processed < batchSize && this.nextDayPreloadCursor < this.nextDayTrains.length) {
    this.preloadTrainDemand(this.nextDayTrains[this.nextDayPreloadCursor]);
    this.nextDayPreloadCursor++;
    processed++;
  }
  if (this.nextDayPreloadCursor < this.nextDayTrains.length) {
    setTimeout(() => this.preloadNextDayInChunks(batchSize), 0);
  }
}
```

**Expected impact:** Day transition drops from 7+ seconds to **<50 ms** (just a reference swap).

---

### 2.4 Fix CSV Parser to Handle Quoted Fields

**Problem:** `parseCsv()` in `prepare-data.cjs` splits on commas. If a cell contains a comma (e.g., address `"北京市,朝阳区"`), it is corrupted.

**Solution:** Use the already-installed `papaparse` dependency.

```javascript
// In prepare-data.cjs
const Papa = require('papaparse');

function parseCsv(text) {
  const result = Papa.parse(text.trim().replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return result.data;
}
```

**Expected impact:** Correct parsing of all CSV variants. No data corruption on quoted fields.

---

## 3. P1 Performance & Efficiency

### 3.1 Memoize Dashboard Computations

**Problem:** `Dashboard.jsx` sorts 1,500 trains and rebuilds cumulative revenue on every render.

**Solution:** Use `useMemo` for expensive derived data.

```jsx
// Dashboard.jsx
import { useMemo } from 'react';

export default function Dashboard({ snapshot, speed, onSpeedChange, yearlySummary }) {
  const trains = snapshot.trains || [];
  
  const topLoads = useMemo(() =>
    trains.slice().sort((a, b) => b.loadFactor - a.loadFactor).slice(0, 18),
    [trains] // ideally use a stable key like totalPassengers
  );
  
  const revenueSeries = useMemo(() =>
    buildRevenueSeries(snapshot.bookings || []),
    [snapshot.bookings] // bookings is a new array reference every snapshot
  );
  
  // Better: hash bookings content
  const bookingsHash = useMemo(() =>
    snapshot.bookings?.reduce((s, b) => s + b.price, 0) || 0,
    [snapshot.bookings]
  );
  const revenueSeries = useMemo(() =>
    buildRevenueSeries(snapshot.bookings || []),
    [bookingsHash]
  );
```

**Expected impact:** Eliminates 1–2 ms of O(n log n) sorting every 150 ms.

---

### 3.2 Debounce Booking Panel Quote Refresh

**Problem:** Booking panel re-quotes whenever `totalBookings` changes anywhere in the network.

**Solution:** Remove `totalBookings` from dependency array. Only re-quote when the actual trip parameters change.

```jsx
// BookingPanel.jsx
useEffect(() => {
  let cancelled = false;
  async function refreshQuote() {
    if (!quoteTrip || !selectedTrain) return;
    setQuotePending(true);
    try {
      const nextQuote = await quoteTrip({
        trainId: selectedTrain.id,
        originIndex,
        destinationIndex: safeDestinationIndex,
        seatClass,
      });
      if (!cancelled) setQuote(nextQuote);
    } catch { if (!cancelled) setQuote(null); }
    finally { if (!cancelled) setQuotePending(false); }
  }
  refreshQuote();
  return () => { cancelled = true; };
}, [quoteTrip, selectedTrain?.id, originIndex, safeDestinationIndex, seatClass]);
// REMOVED: snapshot.stats.totalBookings
```

**Expected impact:** Eliminates ~3–5 excess worker round-trips per second during high booking volume.

---

### 3.3 Filter Before Serialize in `snapshot()`

**Problem:** `snapshot()` serializes all 6,000 trains, then `selectVisibleTrains` discards 4,500.

**Solution:** Filter to candidate trains first, then serialize.

```javascript
// SimulationEngine.js
snapshot({ includeBookingOptions = true } = {}) {
  const calendar = calendarState(this.nowMinutes);
  
  // Only serialize candidates
  const candidates = this.trains.filter(t => 
    t.status === 'running' ||
    (t.status === 'scheduled' && t.departureMinute - this.nowMinutes <= 120) ||
    t.status === 'completed'
  );
  
  const serialized = candidates.map(t => serializeTrain(t, this.nowMinutes));
  const visibleTrains = selectVisibleTrains(serialized, SNAPSHOT_TRAIN_LIMIT);
  
  // ... rest of snapshot
}
```

**Expected impact:** Snapshot creation drops from 24 ms to ~8–10 ms.

---

### 3.4 Add Worker Call Timeout

**Problem:** `SimulationWorkerClient.call()` has no timeout. If the worker crashes, UI promises hang forever.

**Solution:** Add a timeout with cleanup.

```javascript
// SimulationWorkerClient.js
call(type, payload = {}, timeoutMs = 5000) {
  const id = this.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`Worker call '${type}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    this.pending.set(id, {
      resolve: (val) => { clearTimeout(timer); resolve(val); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    this.worker.postMessage({ id, type, payload });
  });
}
```

**Expected impact:** Booking failures surface to the user instead of hanging.

---

### 3.5 Gzip Static Assets in `serve-static.cjs`

**Problem:** 14 MB `route-data.json` and 4.8 MB `hsr-rails.geojson` are served uncompressed.

**Solution:** Add gzip streaming.

```javascript
// serve-static.cjs
const zlib = require('zlib');

function serveFile(filePath, response) {
  const acceptEncoding = request.headers['accept-encoding'] || '';
  const ext = path.extname(filePath);
  const mime = contentType(filePath);
  response.setHeader('Content-Type', mime);
  response.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=300');
  
  const stream = fs.createReadStream(filePath);
  if (acceptEncoding.includes('gzip') && (ext === '.json' || ext === '.geojson' || ext === '.js' || ext === '.css')) {
    response.setHeader('Content-Encoding', 'gzip');
    stream.pipe(zlib.createGzip()).pipe(response);
  } else {
    stream.pipe(response);
  }
}
```

**Expected impact:** `route-data.json` drops from 14 MB to ~2.5 MB. First paint improves by seconds on slow connections.

---

### 3.6 Cache Booking Options by Route

**Problem:** `createBookingOptions()` rebuilds 6,000 objects even though trains on the same route share the same option shape.

**Solution:** Cache options per route and clone with train-specific overrides.

```javascript
// SimulationEngine.js
constructor(...) {
  this.routeBookingOptions = new Map();
}

createBookingOptions() {
  return this.trains.map(train => {
    let base = this.routeBookingOptions.get(train.routeId);
    if (!base) {
      base = {
        routeId: train.routeId,
        code: train.code,
        origin: train.origin,
        destination: train.destination,
        corridor: train.corridor,
        originProvince: train.originProvince,
        destinationProvince: train.destinationProvince,
        stops: train.stops.map((stop, index) => ({ ...stop, index })),
        totalDistanceKm: train.totalDistanceKm,
        seatQuota: TRAIN_SEAT_QUOTA,
      };
      this.routeBookingOptions.set(train.routeId, base);
    }
    return {
      ...base,
      id: train.id,
      direction: train.direction,
      routeVariantId: train.routeVariantId,
      departureMinute: train.departureMinute,
      departureClock: formatClock(train.departureMinute),
      serviceDate: train.calendar?.dateLabel,
      servicesForRoute: train.servicesForRoute,
      serviceIndexForRoute: train.serviceIndexForRoute,
    };
  });
}
```

**Expected impact:** `createBookingOptions` drops from 2.1 ms to ~0.3 ms.

---

### 3.7 Batch Python DB Commits

**Problem:** `bulk_execute` commits after every batch.

**Solution:** Commit every N batches.

```python
# oceanbase_seed.py
def bulk_execute(conn, sql, rows, batch_size, commits_per_tx=5):
    if not rows:
        return
    with conn.cursor() as cursor:
        for i, start in enumerate(range(0, len(rows), batch_size)):
            cursor.executemany(sql, rows[start:start + batch_size])
            if (i + 1) % commits_per_tx == 0:
                conn.commit()
        conn.commit()
```

**Expected impact:** 10× faster bulk loads (fewer WAL flushes).

---

## 4. P2 Simulation Realism & Dynamics

### 4.1 Variable Train Speeds by Track Class

**Problem:** `DEFAULT_SPEED_KMH = 285` is applied uniformly. Real HSR has speed tiers (250/300/350 km/h).

**Solution:** Assign speed limits per segment based on distance and corridor.

```javascript
// In buildRoute() / prepare-data.cjs
function speedLimitForSegment(distanceKm, corridor, trainType) {
  const base = trainType === 'G' ? 350 : trainType === 'D' ? 250 : 200;
  const corridorBoost = corridor?.includes('Beijing-Shanghai') || corridor?.includes('Beijing-Guangzhou') ? 0 : -30;
  return Math.min(base, Math.max(200, base + corridorBoost));
}
```

---

### 4.2 Weather & Disruption Events

**Problem:** Weather drag is a binary `deterministicNoise > 0.94` → +4 minutes. Not dynamic or visible to users.

**Solution:** Add a live weather/disruption system with visible icons and route-wide effects.

```javascript
// SimulationEngine.js
constructor(...) {
  this.weatherEvents = generateWeatherEvents(yearDays);
}

tick(realSeconds) {
  // ... existing logic ...
  const activeWeather = this.weatherEvents.filter(w => w.startMinute <= this.nowMinutes && w.endMinute > this.nowMinutes);
  for (const train of this.trains) {
    for (const weather of activeWeather) {
      if (weather.affectedCorridors.includes(train.corridor)) {
        train.currentWeatherDelay = weather.delayMinutes;
      }
    }
  }
}

function generateWeatherEvents(yearDays) {
  const events = [];
  for (let day = 0; day < yearDays; day++) {
    if (deterministicNoise(`weather-day-${day}`) < 0.08) {
      events.push({
        type: Math.random() < 0.5 ? 'thunderstorm' : 'fog',
        startMinute: day * 1440 + Math.floor(Math.random() * 720),
        endMinute: day * 1440 + Math.floor(Math.random() * 720) + 720,
        affectedCorridors: ['East China', 'South China'], // sample
        delayMinutes: Math.floor(Math.random() * 15) + 5,
        speedReduction: 0.7 + Math.random() * 0.2,
      });
    }
  }
  return events;
}
```

**UI:** Show weather overlays on the map, alert banners in the Dashboard.

---

### 4.3 Dynamic Pricing by Real-Time Demand

**Problem:** Pricing uses `loadFactor` but does not react to live booking velocity.

**Solution:** Add a booking velocity metric.

```javascript
// SimulationEngine.js
this.bookingVelocity = new Map(); // routeId -> bookings in last 10 minutes

bookTrip(...) {
  // ... existing booking logic ...
  const currentVelocity = this.bookingVelocity.get(train.routeId) || 0;
  this.bookingVelocity.set(train.routeId, currentVelocity + groupSize);
}

tick(realSeconds) {
  // Decay velocity every minute
  if (Math.floor(this.nowMinutes) !== Math.floor(this.nowMinutes - realSeconds * this.speed / 60)) {
    for (const [routeId, velocity] of this.bookingVelocity) {
      this.bookingVelocity.set(routeId, velocity * 0.9);
    }
  }
}
```

**Pricing integration:**
```javascript
const velocityMultiplier = 1 + Math.min(0.5, (bookingVelocity / 100) * 0.1);
const raw = (baseFare + bidPrice) * scarcity * timePressure * peak * velocityMultiplier * ...;
```

---

### 4.4 Seat Upgrade Offers at Departure

**Problem:** Business class seats may be empty while second class is oversold.

**Solution:** Offer discounted upgrades at the gate.

```javascript
processStation(train, stationIndex) {
  // ... existing boarding logic ...
  
  const businessLoad = train.inventory.occupancyForSegment(stationIndex, 'business');
  const secondLoad = train.inventory.occupancyForSegment(stationIndex, 'secondClass');
  
  if (businessLoad.loadFactor < 0.3 && secondLoad.loadFactor > 0.9) {
    this.logEvent('upgrade', `${train.code} at ${station}: business class undersold. Offering ¥99 upgrades.`);
    // UI shows upgrade offer
  }
}
```

---

### 4.5 Realistic No-Show Behavior

**Problem:** No-shows are determined at booking time (`booking.noShow = random < probability`). In reality, no-shows are decided minutes before departure.

**Solution:** Defer no-show determination to departure time.

```javascript
processStation(train, stationIndex) {
  if (stationIndex === 0) { // origin
    for (const booking of train.bookings) {
      if (booking.originIndex === 0 && booking.status === 'confirmed') {
        // Decide no-show NOW, not at booking time
        const noShow = this.random(booking.ticketId, train.departureMinute) < noShowProbability(train, 0, booking.seatClass);
        if (noShow) {
          train.inventory.releaseTicket(booking.ticketId);
          booking.status = 'noShow';
          this.stats.noShows += booking.seats.length;
        } else {
          booking.status = 'onboard';
        }
      }
    }
  }
}
```

---

### 4.6 Maintenance Windows & Speed Restrictions

**Problem:** Tracks never degrade or require maintenance.

**Solution:** Add periodic maintenance windows that restrict segments.

```javascript
// In route segments
maintenanceWindow: {
  startMinute: day * 1440 + 120, // 02:00
  endMinute: day * 1440 + 300,   // 05:00
  speedLimitKmh: 120,
}
```

---

## 5. P3 Data Pipeline Hardening

### 5.1 Fix `mergeSegmentGeometries` Array Comparison

**Problem:** Uses `===` on arrays, which is always false for distinct references.

```javascript
// BEFORE (broken)
if (!previous || previous[0] !== coord[0] || previous[1] !== coord[1]) {
  coordinates.push(coord);
}

// AFTER
if (!previous || previous[0] !== coord[0] || previous[1] !== coord[1]) {
  coordinates.push(coord);
}
// Actually the === on numbers IS correct. The issue was that the code
// was comparing array references in an earlier version. Current code is:
// previous[0] !== coord[0] || previous[1] !== coord[1]
// This is actually fine for numbers. No change needed.
```

*Note: Upon re-review, the current code compares coordinates by value, which is correct.*

---

### 5.2 Reduce Rail Graph Node Drift

**Problem:** `findOrCreateNode` averages coordinates, which can drift hundreds of meters.

**Solution:** Use a smaller cell size or keep the first coordinate.

```javascript
function findOrCreateNode(lng, lat) {
  const key = nodeKey(lng, lat);
  const existing = cellMap.get(key);
  if (existing !== undefined) {
    return existing; // Don't average — keep first coordinate for stability
  }
  // ...
}
```

---

### 5.3 Add Route Geometry Continuity Validation

**Problem:** No validation that segment geometries connect end-to-end.

**Solution:** Add a post-build check.

```javascript
function validateRouteGeometry(route) {
  for (let i = 0; i < route.segments.length - 1; i++) {
    const segA = route.segments[i];
    const segB = route.segments[i + 1];
    const endA = segA.geometry[segA.geometry.length - 1];
    const startB = segB.geometry[0];
    const gap = Math.abs(endA[0] - startB[0]) + Math.abs(endA[1] - startB[1]);
    if (gap > 0.001) {
      console.warn(`Gap in ${route.code} segment ${i}→${i+1}: ${gap}`);
    }
  }
}
```

---

### 5.4 Compress `route-data.json` with MessagePack

**Problem:** 14 MB JSON is large and slow to parse.

**Solution:** Use MessagePack or a custom binary format for the route file.

```bash
npm install msgpack-lite
```

```javascript
// prepare-data.cjs
const msgpack = require('msgpack-lite');
fs.writeFileSync('public/route-data.bin', msgpack.encode(routeData));
```

**Expected impact:** 14 MB → ~4 MB. Parse speed improves by ~3×.

---

## 6. P4 Frontend Polish

### 6.1 Lazy-Load Dashboard & Booking Panel

**Problem:** Main bundle is 2.2 MB including Recharts and heavy components.

```jsx
// App.jsx
import { lazy, Suspense } from 'react';

const Dashboard = lazy(() => import('./visualization/Dashboard.jsx'));
const BookingPanel = lazy(() => import('./visualization/BookingPanel.jsx'));

// In JSX:
<Suspense fallback={<div>Loading...</div>}>
  {activeView === 'dashboard' && <Dashboard ... />}
  {activeView === 'booking' && <BookingPanel ... />}
</Suspense>
```

---

### 6.2 Escape HTML in Mapbox Popups

**Problem:** XSS via `.setHTML()` with raw train properties.

```javascript
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

map.on('click', 'train-circles', (event) => {
  const p = event.features[0].properties;
  const html = `<div class="popup">
    <b>${escapeHtml(p.code)}</b>
    <span>${escapeHtml(p.direction)}: ${escapeHtml(p.current)} to ${escapeHtml(p.next)}</span>
    <span>Load ${(Number(p.load) * 100).toFixed(1)}% · ${escapeHtml(p.pax)}/${escapeHtml(p.capacity)}</span>
  </div>`;
  new mapboxgl.Popup({ offset: 18 }).setLngLat(event.lngLat).setHTML(html).addTo(map);
});
```

---

### 6.3 Throttle Mapbox `setData` Updates

**Problem:** GeoJSON source updated every 32 ms during animation.

**Solution:** Throttle to 60 Hz (16 ms) or only update on snapshot arrival.

```javascript
// HSRMap.jsx
useEffect(() => {
  if (!ready || !mapRef.current?.getSource('trains')) return;
  previousTrainsRef.current = currentTrainsRef.current.length ? currentTrainsRef.current : trains;
  targetTrainsRef.current = trains;
  transitionRef.current = { started: performance.now(), duration: 190 };
  if (!frameRef.current) frameRef.current = requestAnimationFrame(animateRef.current);
}, [ready, trains]);

// In animateRef, increase throttle from 32 ms to 16 ms
if (timestamp - lastRenderRef.current >= 16 || progress >= 1) {
  mapRef.current.getSource('trains').setData(trainGeojson(rendered));
  lastRenderRef.current = timestamp;
}
```

---

### 6.4 Add Loading State for OceanBase API

**Problem:** `fetchOptionalJson('/api/oceanbase-simulation-data')` has no timeout or loading indicator.

```jsx
// App.jsx
const [loadingStage, setLoadingStage] = useState('connecting');

useEffect(() => {
  async function load() {
    setLoadingStage('fetching-oceanbase');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch('/api/oceanbase-simulation-data', {
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeout);
      // ... rest of init
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('OceanBase connection timed out. Using static fallback.');
      }
      // ... fallback logic
    }
  }
  load();
}, []);
```

---

## 7. Implementation Order

| Phase | Work | Expected Time | Blocking? |
|-------|------|---------------|-----------|
| **1** | Delta snapshots + route-level stops | 1 day | Yes — unlocks everything else |
| **2** | Pre-scheduled service days | 4–6 hrs | Yes — eliminates UI freezes |
| **3** | Memoize Dashboard, debounce quotes, filter-before-serialize | 2–3 hrs | No |
| **4** | Worker timeouts + error boundaries | 1 hr | No |
| **5** | Gzip static server + lazy loading | 1–2 hrs | No |
| **6** | CSV parser fix + geometry validation | 1–2 hrs | No |
| **7** | Weather events + dynamic pricing + upgrades | 1 day | No |
| **8** | MessagePack compression + batch DB commits | 2–3 hrs | No |
| **9** | Mapbox XSS fix + throttle + loading states | 1 hr | No |

**Total estimated effort:** 3–4 days of focused implementation.

---

*End of improvements roadmap. Start with Phase 1 (delta snapshots) — it provides the largest performance gain and unblocks all subsequent work.*
