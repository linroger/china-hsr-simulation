import { SimulationEngine } from './SimulationEngine.js';

const SNAPSHOT_INTERVAL_MS = 100;

let engine = null;
let publishTimer = null;
let initialized = false;

self.onmessage = (event) => {
  const { id, type, payload = {} } = event.data || {};
  try {
    if (type === 'init') {
      engine?.stop();
      stopPublishing();
      engine = new SimulationEngine(payload);
      engine.setSpeed(payload.speed || 18);
      initialized = true;
      postSnapshot('init');
      respond(id, { ok: true, worker: workerInfo() });
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
  publishTimer = setInterval(() => postSnapshot('tick'), SNAPSHOT_INTERVAL_MS);
}

function stopPublishing() {
  if (publishTimer) clearInterval(publishTimer);
  publishTimer = null;
}

function postSnapshot(reason) {
  if (!engine) return;
  self.postMessage({
    type: 'snapshot',
    reason,
    snapshot: {
      ...engine.snapshot({ includeBookingOptions: reason !== 'tick' }),
      worker: workerInfo(),
    },
  });
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
  };
}
