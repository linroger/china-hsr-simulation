import { SimulationEngine } from './SimulationEngine.js';

const SNAPSHOT_INTERVAL_MS = 200;
const LEDGER_FLUSH_INTERVAL_MS = 4000;
const LEDGER_BATCH_LIMIT = 800;

let engine = null;
let publishTimer = null;
let preloadTimer = null;
let ledgerTimer = null;
let initialized = false;
let lastPublishedServiceDayIndex = null;
let ledgerEndpoint = null;
let lastPublishedTrains = new Map();

self.onmessage = (event) => {
  const { id, type, payload = {} } = event.data || {};
  try {
    if (type === 'init') {
      engine?.stop();
      stopPublishing();
      stopBackgroundPreload();
      stopLedgerFlush();
      engine = new SimulationEngine({ ...payload, preloadDemand: payload.preloadDemand ?? false });
      engine.setSpeed(payload.speed || 120);
      ledgerEndpoint = payload.ledgerEndpoint || null;
      initialized = true;
      lastPublishedServiceDayIndex = null;
      postSnapshot('init');
      respond(id, { ok: true, worker: workerInfo() });
      startBackgroundPreload();
      startLedgerFlush();
      return;
    }

    assertEngine();

    if (type === 'start') {
      engine.start();
      startPublishing();
      respond(id, { ok: true });
    } else if (type === 'stop') {
      engine.stop();
      stopPublishing();
      respond(id, { ok: true });
    } else if (type === 'setSpeed') {
      engine.setSpeed(payload.speed);
      respond(id, { ok: true });
    } else if (type === 'quoteTrip') {
      respond(id, engine.quoteTrip(payload));
    } else if (type === 'bookTrip') {
      const result = engine.bookTrip(payload);
      postSnapshot('booking');
      respond(id, result);
    } else if (type === 'injectScenario') {
      const scenario = engine.injectScenario(payload.scenarioType, payload.params || {});
      respond(id, scenario
        ? { ok: true, scenario: { id: scenario.id, type: scenario.type, label: scenario.label, untilMinute: scenario.untilMinute } }
        : { ok: false, error: `Unknown scenario type: ${payload.scenarioType}` });
    } else if (type === 'snapshot') {
      const snapshot = engine.snapshot();
      // Sync lastPublishedTrains so subsequent tick deltas remain consistent
      // with any manual snapshot the frontend may have applied.
      lastPublishedTrains = new Map(snapshot.trains.map((t) => [t.id, t]));
      respond(id, snapshot);
    } else {
      throw new Error(`Unknown worker message type: ${type}`);
    }
  } catch (error) {
    respond(id, { ok: false, error: error.message || String(error) });
    self.postMessage({ type: 'error', error: error.message || String(error) });
  }
};

function startPublishing() {
  stopPublishing();
  publishTimer = setInterval(() => {
    ensureBackgroundPreload();
    postSnapshot('tick');
  }, SNAPSHOT_INTERVAL_MS);
}

function stopPublishing() {
  if (publishTimer) clearInterval(publishTimer);
  publishTimer = null;
}

function trainStateChanged(a, b) {
  if (!a || !b) return true;
  return (
    a.status !== b.status ||
    a.currentSegmentIndex !== b.currentSegmentIndex ||
    Math.abs(a.routeProgress - b.routeProgress) > 1e-6 ||
    Math.abs(a.loadFactor - b.loadFactor) > 1e-4 ||
    a.passengerCount !== b.passengerCount ||
    a.currentStation !== b.currentStation ||
    a.nextStation !== b.nextStation ||
    Math.abs((a.coords?.lng || 0) - (b.coords?.lng || 0)) > 1e-8 ||
    Math.abs((a.coords?.lat || 0) - (b.coords?.lat || 0)) > 1e-8
  );
}

function postSnapshot(reason) {
  if (!engine) return;
  const serviceDayIndex = engine.currentServiceDayIndex;
  // Never include booking options in preload snapshots — they are large and
  // the UI doesn't need them until init/manual/booking/day-boundary.
  const includeBookingOptions = (reason === 'init' || reason === 'booking' || reason === 'manual' || serviceDayIndex !== lastPublishedServiceDayIndex) && reason !== 'preload' && reason !== 'preload-complete';
  const snapshot = engine.snapshot({ includeBookingOptions });

  // Full snapshots on init, booking, manual, or day boundary. Deltas on tick.
  const isFullSnapshot = reason === 'init' || reason === 'booking' || reason === 'manual' || serviceDayIndex !== lastPublishedServiceDayIndex;

  if (isFullSnapshot) {
    lastPublishedTrains = new Map(snapshot.trains.map((t) => [t.id, t]));
    lastPublishedServiceDayIndex = serviceDayIndex;
    self.postMessage({
      type: 'snapshot',
      reason,
      snapshot: {
        ...snapshot,
        delta: false,
        worker: workerInfo(),
      },
    });
    return;
  }

  // Delta snapshot: only send trains whose state changed since last publish.
  const changedTrains = [];
  const currentIds = new Set();
  for (const train of snapshot.trains) {
    currentIds.add(train.id);
    const last = lastPublishedTrains.get(train.id);
    if (!last || trainStateChanged(last, train)) {
      changedTrains.push(train);
      lastPublishedTrains.set(train.id, train);
    }
  }

  // Remove trains that are no longer in the visible set.
  const removedTrainIds = [];
  for (const [id, _] of lastPublishedTrains) {
    if (!currentIds.has(id)) removedTrainIds.push(id);
  }
  for (const id of removedTrainIds) lastPublishedTrains.delete(id);

  lastPublishedServiceDayIndex = serviceDayIndex;
  self.postMessage({
    type: 'snapshot',
    reason,
    snapshot: {
      ...snapshot,
      trains: changedTrains,
      removedTrainIds,
      delta: true,
      worker: workerInfo(),
    },
  });
}

function ensureBackgroundPreload() {
  if (!engine || preloadTimer || !engine.hasPendingDemandPreload()) return;
  startBackgroundPreload();
}

function startBackgroundPreload() {
  stopBackgroundPreload();
  const runChunk = () => {
    if (!engine) return;
    const result = engine.preloadDemandBatch(60);
    if (result.done) {
      engine.logEvent('demand', `Background demand preload complete: ${engine.stats.totalPassengers.toLocaleString()} passengers booked.`);
      postSnapshot('preload-complete');
      stopBackgroundPreload();
    } else {
      preloadTimer = setTimeout(runChunk, 8);
    }
  };
  preloadTimer = setTimeout(runChunk, 0);
}

function stopBackgroundPreload() {
  if (preloadTimer) clearTimeout(preloadTimer);
  preloadTimer = null;
}

function startLedgerFlush() {
  if (!ledgerEndpoint) return;
  stopLedgerFlush();
  ledgerTimer = setInterval(() => {
    flushLedger().catch(() => {
      // Network errors are non-fatal — bookings still live in the engine.
    });
  }, LEDGER_FLUSH_INTERVAL_MS);
}

function stopLedgerFlush() {
  if (ledgerTimer) clearInterval(ledgerTimer);
  ledgerTimer = null;
}

async function flushLedger() {
  if (!engine || !ledgerEndpoint) return;
  const drained = engine.drainLedger(LEDGER_BATCH_LIMIT);
  if (!drained.length) return;
  const ndjson = drained.map((entry) => JSON.stringify(entry)).join('\n');
  try {
    const response = await fetch(ledgerEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: ndjson,
      keepalive: true,
    });
    if (!response.ok) throw new Error(`Ledger ingest failed with HTTP ${response.status}`);
  } catch (error) {
    // Re-queue on failure so we try again next interval. Cap at 4000 to bound memory.
    engine.ledger = engine.ledger ? [...drained, ...engine.ledger].slice(-4000) : drained.slice(-4000);
  }
}

function respond(id, payload) {
  if (id === undefined || id === null) return;
  self.postMessage({ type: 'response', id, payload });
}

function assertEngine() {
  if (!initialized || !engine) throw new Error('Simulation worker has not been initialized.');
}

function workerInfo() {
  return {
    mode: 'web-worker',
    thread: 'simulation-worker',
    snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
    demandPreload: engine?.preloadCursor >= engine?.trains?.length ? 'complete' : 'streaming',
  };
}
