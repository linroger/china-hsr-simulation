import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulationEngine } from '../src/simulation_core/SimulationEngine.js';

// Minimal mock stations and routes for testing
const mockStations = [
  { station_code: 'BJI', station_name: 'Beijing', lon: 116.4, lat: 39.9 },
  { station_code: 'SHA', station_name: 'Shanghai', lon: 121.4, lat: 31.2 },
];
const mockRoutes = [
  {
    id: 'G1',
    code: 'G1',
    origin: 'Beijing',
    destination: 'Shanghai',
    stops: [
      { name: 'Beijing', lon: 116.4, lat: 39.9, arriveMinutes: 0, departMinutes: 0, dwellMinutes: 0 },
      { name: 'Shanghai', lon: 121.4, lat: 31.2, arriveMinutes: 300, departMinutes: 300, dwellMinutes: 0 },
    ],
    segments: [
      { distanceKm: 1318, speedLimitKmh: 350, geometry: [[116.4, 39.9], [121.4, 31.2]] },
    ],
    totalDistanceKm: 1318,
    frequencyRank: 0.8,
  },
];

test('enhancements: lazy SeatInventory allocation and memory reclamation', () => {
  const engine = new SimulationEngine({
    stations: mockStations,
    routes: mockRoutes,
    preloadDemand: false,
    maxTrains: 2,
  });

  const train = engine.trains[0];

  // 1. Verify lazy SeatInventory: initially null
  assert.equal(train._inventory, null);

  // Accessing train.inventory triggers initialization
  const inv = train.inventory;
  assert.ok(inv);
  assert.ok(train._inventory);
  assert.equal(train._inventory, inv);

  // 2. Verify memory reclamation when train completed
  train.completed = true;
  train.status = 'completed';
  train._inventory = null;
  train.bookings = [{ ticketId: 'T1' }];

  // Accessing train.inventory now returns the dummy mock, not a new SeatInventory
  const dummyInv = train.inventory;
  assert.ok(dummyInv);
  assert.equal(train._inventory, null); // remains null
  assert.equal(dummyInv.occupiedOnSegment(0), 0);
  assert.deepEqual(dummyInv.occupancyForSegment(0), { loadFactor: 0, occupied: 0, capacity: 556 });
});

test('enhancements: scenario history tracking and limit constraints', () => {
  const engine = new SimulationEngine({
    stations: mockStations,
    routes: mockRoutes,
    preloadDemand: false,
    maxTrains: 2,
  });

  // 1. Inject thunderstorm scenario
  const scenario = engine.injectScenario('thunderstorm', { durationHours: 1 });
  assert.ok(scenario);
  assert.equal(engine.scenarioHistory.length, 1);
  
  const historyItem = engine.scenarioHistory[0];
  assert.equal(historyItem.id, scenario.id);
  assert.equal(historyItem.status, 'active');
  assert.equal(historyItem.durationHours, 1);

  // 2. Expire the scenario via tick advance
  engine.nowMinutes += 70; // past the 60 min duration
  engine.tick(0.001); // triggers scenario checks

  assert.equal(historyItem.status, 'expired');
  assert.ok(historyItem.endMinute > historyItem.startMinute);

  // 3. Verify scenarioHistory limit (50 items)
  for (let i = 0; i < 55; i++) {
    engine.injectScenario('high_wind', { durationHours: 1 });
  }
  assert.ok(engine.scenarioHistory.length <= 50);
});
