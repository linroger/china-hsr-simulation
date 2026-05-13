export class SimulationWorkerClient {
  constructor({ onSnapshot, onError } = {}) {
    this.worker = new Worker(new URL('./simulationWorker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.onSnapshot = onSnapshot;
    this.onError = onError;
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      this.onError?.(event.message || 'Simulation worker failed.');
    };
  }

  init(payload) {
    return this.call('init', payload);
  }

  start() {
    return this.call('start');
  }

  stop() {
    return this.call('stop');
  }

  setSpeed(speed) {
    return this.call('setSpeed', { speed });
  }

  quoteTrip(payload) {
    return this.call('quoteTrip', payload);
  }

  bookTrip(payload) {
    return this.call('bookTrip', payload);
  }

  snapshot() {
    return this.call('snapshot');
  }

  terminate() {
    for (const { reject } of this.pending.values()) reject(new Error('Simulation worker terminated.'));
    this.pending.clear();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }

  handleMessage(message) {
    if (message.type === 'snapshot') {
      this.onSnapshot?.(message.snapshot);
      return;
    }
    if (message.type === 'error') {
      this.onError?.(message.error);
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      const payload = message.payload;
      if (payload?.ok === false && payload.error) pending.reject(new Error(payload.error));
      else pending.resolve(payload);
    }
  }

  call(type, payload = {}, timeoutMs = 10000) {
    const id = this.nextId;
    this.nextId += 1;
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
}
