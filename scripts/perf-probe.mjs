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
