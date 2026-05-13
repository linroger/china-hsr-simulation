import { SimulationEngine } from './SimulationEngine.js';

const SNAPSHOT_INTERVAL_MS = 150;
const LEDGER_FLUSH_INTERVAL_MS = 4000;
const LEDGER_BATCH_LIMIT = 800;

let engine = null;
let publishTimer = null;
let preloadTimer = null;
let ledgerTimer = null;
let initialized = false;
let lastPublishedServiceDayIndex = null;
let ledgerEndpoint = null;

self.onmessage = (event) => {
  const { id, type, payload = {} } = event.data || {};
  try {
    if (type === 'init') {
      engine?.stop();
      stopPublishing();
      stopBackgroundPreload();
      stopLedgerFlush();
      engine = new SimulationEngine({ ...payload, preloadDemand: payload.preloadDemand ?? false });
      engine.setSpeed(payload.speed || 60);
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
    } else if (type === 'snapshot') {
      respond(id, engine.snapshot());
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

function postSnapshot(reason) {
  if (!engine) return;
  const serviceDayIndex = engine.currentServiceDayIndex;
  // Never include booking options in preload snapshots — they are large and
  // the UI doesn't need them until init/manual/booking/day-boundary.
  const includeBookingOptions = (reason === 'init' || reason === 'booking' || reason === 'manual' || serviceDayIndex !== lastPublishedServiceDayIndex) && reason !== 'preload' && reason !== 'preload-complete';
  const snapshot = engine.snapshot({ includeBookingOptions });
  lastPublishedServiceDayIndex = serviceDayIndex;
  self.postMessage({
    type: 'snapshot',
    reason,
    snapshot: {
      ...snapshot,
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
