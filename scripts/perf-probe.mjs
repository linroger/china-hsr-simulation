#!/usr/bin/env node
/**
 * Full-engine performance probe: instantiates the engine from the generated
 * data exactly like the worker does, preloads demand, then measures tick and
 * snapshot latency at simulation speed 120.
 *
 * Usage: node scripts/perf-probe.mjs [tickCount]
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SimulationEngine } from '../src/simulation_core/SimulationEngine.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const tickCount = Number(process.argv[2] || 400);

const routeData = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'route-data.json'), 'utf8'));
const stationData = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'station-data.json'), 'utf8'));

const initStart = performance.now();
const engine = new SimulationEngine({
  stations: stationData.stations,
  routes: routeData.routes,
  seed: 20260611,
  preloadDemand: false,
});
engine.setSpeed(120);
const initMs = performance.now() - initStart;

const preloadStart = performance.now();
engine.preloadDemand();
const preloadMs = performance.now() - preloadStart;

const tickDurations = [];
const snapshotDurations = [];
for (let i = 0; i < tickCount; i += 1) {
  let started = performance.now();
  engine.tick(0.05);
  tickDurations.push(performance.now() - started);
  if (i % 4 === 0) {
    started = performance.now();
    engine.snapshot({ includeBookingOptions: false });
    snapshotDurations.push(performance.now() - started);
  }
}

const percentile = (values, p) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const fmt = (value) => `${Math.round(value * 100) / 100} ms`;

console.log(`init: ${fmt(initMs)} (${engine.trains.length} trains, ${engine.routes.length} routes)`);
console.log(`preload: ${fmt(preloadMs)} (${engine.stats.totalPassengers.toLocaleString()} passengers)`);
console.log(`tick    p50=${fmt(percentile(tickDurations, 0.5))} p95=${fmt(percentile(tickDurations, 0.95))} max=${fmt(Math.max(...tickDurations))} over ${tickDurations.length} ticks`);
console.log(`snapshot p50=${fmt(percentile(snapshotDurations, 0.5))} p95=${fmt(percentile(snapshotDurations, 0.95))} max=${fmt(Math.max(...snapshotDurations))} over ${snapshotDurations.length} snapshots`);
console.log(`stats: active=${engine.snapshot().stats.activeTrains} revenue=¥${Math.round(engine.stats.totalRevenue).toLocaleString()} scenarios=${engine.activeScenarios.length}`);

// Coarse regression gates. Thresholds are deliberately generous (2-4x the
// healthy baseline on a 2024 laptop) so they don't flake on slower CI hardware,
// but still catch order-of-magnitude regressions: the per-route service floor
// over-allocating trains to OOM (was 10,800), or the demand preload returning to
// its ~144s pre-optimization cost. p95 (not max) is used so a one-off GC pause
// can't fail the gate.
const tickP95 = percentile(tickDurations, 0.95);
const snapshotP95 = percentile(snapshotDurations, 0.95);
const checks = [
  ['train count within daily budget', engine.trains.length <= 6200, `${engine.trains.length} trains`],
  ['preload under 120s', preloadMs < 120_000, fmt(preloadMs)],
  ['tick p95 under 250ms', tickP95 < 250, fmt(tickP95)],
  ['snapshot p95 under 400ms', snapshotP95 < 400, fmt(snapshotP95)],
];
let failed = false;
for (const [name, ok, actual] of checks) {
  if (!ok) { console.error(`PERF REGRESSION: ${name} (got ${actual})`); failed = true; }
}
if (failed) process.exitCode = 1;
else console.log('perf gates: PASS');
