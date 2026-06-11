import assert from 'node:assert/strict';
import test from 'node:test';
import { hourlyDemandShape, SimulationEngine } from '../src/simulation_core/SimulationEngine.js';
import { SeatInventory } from '../src/algorithms/seatInventory.js';

const route = {
  id: 'r1',
  code: 'G1',
  type: 'G',
  origin: 'A',
  destination: 'D',
  totalDistanceKm: 300,
  frequencyRank: 0.5,
  corridor: 'East China / North China',
  stops: [
    { name: 'A', lng: 116, lat: 39, tier: 'national-hub' },
    { name: 'B', lng: 117, lat: 39, tier: 'local' },
    { name: 'C', lng: 118, lat: 39, tier: 'local' },
    { name: 'D', lng: 119, lat: 39, tier: 'regional-hub' },
  ],
  segments: [
    { from: 'A', to: 'B', distanceKm: 100 },
    { from: 'B', to: 'C', distanceKm: 100 },
    { from: 'C', to: 'D', distanceKm: 100 },
  ],
};

function restageRunningTrain(engine, trainId, segmentMinutes) {
  const train = engine.getTrain(trainId);
  const baseRoute = train.baseRoute;
  train.direction = 'outbound';
  train.legIndex = 0;
  train.routeVariantId = train.outboundVariantId;
  train.origin = baseRoute.origin;
  train.destination = baseRoute.destination;
  train.stops = baseRoute.stops;
  train._serializedStops = null;
  train.segments = baseRoute.segments;
  train.inventory = new SeatInventory(baseRoute.stops);
  train.bookings = [];
  train._bookingIndexes = null;
  train.completedLegs = [];
  train.departureMinute = engine.nowMinutes;
  train.segmentMinutes = segmentMinutes.slice();
  train.plannedSegmentMinutes = segmentMinutes.slice();
  train.delayMinutes = 0;
  train.status = 'scheduled';
  train.currentSegmentIndex = 0;
  train.segmentProgress = 0;
  train.processedStationIndexes = new Set();
  train.completed = false;
  engine.updateTrain(train);
  return train;
}

test('disruption scenario slows each affected running train exactly once and then expires', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 7, maxTrains: 1, preloadDemand: false });
  engine.autoDisturbances = false;
  const train = restageRunningTrain(engine, 'r1', [10, 10, 10]);
  assert.equal(train.status, 'running');

  const scenario = engine.injectScenario('thunderstorm', {
    corridors: [route.corridor],
    delayMinutes: 12,
    durationHours: 1,
  });
  assert.ok(scenario);
  assert.equal(scenario.type, 'weather');

  const before = train.segmentMinutes.slice();
  engine.applyDisruptionScenarios();
  assert.equal(train.segmentMinutes[0], before[0], 'current segment must not be stretched (no position regression)');
  assert.ok(train.segmentMinutes[1] > before[1], 'remaining segments must be slowed');
  assert.ok(train.segmentMinutes[2] > before[2], 'remaining segments must be slowed');
  const addedDelay = train.delayMinutes;
  assert.ok(addedDelay >= 12 * 0.6 && addedDelay <= 12 * 1.4, `scenario delay ${addedDelay} outside severity envelope`);
  assert.ok(scenario.appliedTrainIds.has(train.id));

  // Re-applying must be a no-op: the impact is one-time per train.
  const afterFirst = train.segmentMinutes.slice();
  engine.applyDisruptionScenarios();
  assert.deepEqual(train.segmentMinutes, afterFirst);
  assert.equal(train.delayMinutes, addedDelay);

  // Scenario expires once the clock passes untilMinute.
  engine.nowMinutes = scenario.untilMinute + 1;
  engine.tick(0);
  assert.equal(engine.activeScenarios.length, 0);
});

test('demand surge scenario lifts calendar demand and price multipliers while active', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 8, maxTrains: 1, preloadDemand: false });
  engine.autoDisturbances = false;
  const baselineDemand = engine.calendar.demandMultiplier;
  engine.injectScenario('surge_demand', { surge: baselineDemand + 0.9, priceSurge: 1.45, durationHours: 2 });
  engine.tick(0);
  assert.ok(engine.calendar.demandMultiplier >= baselineDemand + 0.9);
  assert.ok(engine.calendar.priceSurgeMultiplier >= 1.45);
});

test('automatic disturbances are deterministic for a fixed seed', () => {
  const build = () => {
    const engine = new SimulationEngine({ routes: [route], seed: 99, maxTrains: 1, preloadDemand: false });
    for (let minute = 0; minute < 1440 * 5; minute += 30) {
      engine.maybeInjectAutoDisturbance(minute);
    }
    return engine.activeScenarios.map((scenario) => `${scenario.label}@${Math.round(scenario.untilMinute)}`);
  };
  const first = build();
  const second = build();
  assert.deepEqual(first, second, 'same seed must replay the same disturbances');
  assert.ok(first.length >= 1, 'expected at least one auto disturbance across five simulated days of rolls');
  assert.ok(first.length <= 3, 'auto disturbances must respect the concurrency cap');
});

test('hourly demand shape has an overnight trough and morning/evening peaks', () => {
  const overnight = hourlyDemandShape(3 * 60);
  const morningPeak = hourlyDemandShape(8 * 60 + 30);
  const midday = hourlyDemandShape(13 * 60);
  const eveningPeak = hourlyDemandShape(18 * 60);
  assert.ok(overnight < 0.2);
  assert.ok(morningPeak > midday);
  assert.ok(eveningPeak > midday);
  assert.ok(morningPeak > overnight * 5);
});
