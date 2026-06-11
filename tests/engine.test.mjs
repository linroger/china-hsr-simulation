import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarState, effectiveMinTrainsPerRoute, SimulationEngine } from '../src/simulation_core/SimulationEngine.js';
import { SeatInventory } from '../src/algorithms/seatInventory.js';

const route = {
  id: 'r1',
  code: 'G1',
  type: 'G',
  origin: 'A',
  destination: 'D',
  totalDistanceKm: 300,
  frequencyRank: 0.5,
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

/**
 * Fully re-stage a train back to a pristine outbound scheduled state.
 * The engine constructor runs tick(0), which can already advance or even
 * complete early-departing services, so movement tests must reset every
 * lifecycle field — not just status/progress — before driving the clock.
 */
function restageTrain(engine, trainId, segmentMinutes, { departureMinute = engine.nowMinutes, turnaroundMinutes = 1 } = {}) {
  const train = engine.getTrain(trainId);
  const baseRoute = train.baseRoute;
  train.direction = 'outbound';
  train.legIndex = 0;
  train.routeVariantId = train.outboundVariantId;
  train.origin = baseRoute.origin;
  train.destination = baseRoute.destination;
  train.originProvince = baseRoute.originProvince;
  train.destinationProvince = baseRoute.destinationProvince;
  train.stops = baseRoute.stops;
  train._serializedStops = null;
  train.segments = baseRoute.segments;
  train.inventory = new SeatInventory(baseRoute.stops);
  train.bookings = [];
  train._bookingIndexes = null;
  train.completedLegs = [];
  train.departureMinute = departureMinute;
  train.turnaroundDepartureMinute = null;
  train.terminalTurnaroundMinutes = turnaroundMinutes;
  train.segmentMinutes = segmentMinutes.slice();
  train.plannedSegmentMinutes = segmentMinutes.slice();
  train.delayMinutes = 0;
  train.status = 'scheduled';
  train.currentSegmentIndex = 0;
  train.segmentProgress = 0;
  train.processedStationIndexes = new Set();
  train.completed = false;
  return train;
}

test('booking engine returns ticket details and mutates interval availability', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 1, preloadDemand: false });
  const quote = engine.quoteTrip({ trainId: 'r1', originIndex: 0, destinationIndex: 2, seatClass: 'secondClass' });
  assert.equal(quote.canBook, true);
  assert.ok(quote.price !== 0 || quote.pricing.price > 0);

  const booking = engine.bookTrip({ trainId: 'r1', originIndex: 0, destinationIndex: 2, seatClass: 'secondClass', passengerName: 'Test' });
  assert.equal(booking.ok, true);
  assert.match(booking.booking.ticketId, /^T/);
  assert.equal(booking.booking.seats[0].car >= 1, true);

  const sameTrain = engine.getTrain('r1');
  const seatId = booking.booking.seats[0].seatId;
  assert.equal(sameTrain.inventory.isSeatAvailable(seatId, 1, 3), false);
  assert.equal(sameTrain.inventory.isSeatAvailable(seatId, 2, 3), true);
});

test('engine creates scalable scheduled services and full booking options', () => {
  const routes = Array.from({ length: 20 }, (_, index) => ({
    ...route,
    id: `r${index}`,
    code: `G${index + 1}`,
    origin: `A${index}`,
    destination: `D${index}`,
    corridor: index % 2 ? 'East China / North China' : 'South China / Southwest China',
    originProvince: index % 2 ? '北京' : '广东',
    destinationProvince: index % 2 ? '上海' : '四川',
  }));
  const engine = new SimulationEngine({ routes, seed: 2, maxTrains: 30 });
  const snapshot = engine.snapshot();

  // The per-route service floor adapts to the budget: a tight budget over
  // many routes degrades to the 2-train floor instead of overriding it.
  const minPerRoute = effectiveMinTrainsPerRoute(routes.length, 30);
  assert.equal(minPerRoute, 2);
  assert.equal(engine.trains.length, routes.length * minPerRoute);
  assert.equal(snapshot.bookingOptions.length, engine.trains.filter((train) => !train.completed).length);
  assert.equal(snapshot.stats.minTrainsPerRoute, minPerRoute);
  assert.ok(snapshot.network.corridors.length >= 2);
  assert.ok(engine.trains.some((train) => train.delayMinutes > 0), 'expected planned-vs-actual delay modeling on some trains');
});

test('per-route service floor respects the daily train budget', () => {
  // Curated OceanBase route set keeps the full 6-train floor.
  assert.equal(effectiveMinTrainsPerRoute(222, 6000), 6);
  // The 1,800-route static fallback degrades to 2/route — 1,800 x 6 trains
  // of 554-seat inventories previously exhausted the worker heap.
  assert.equal(effectiveMinTrainsPerRoute(1800, 6000), 2);
  assert.equal(effectiveMinTrainsPerRoute(20, 30), 2);
  assert.equal(effectiveMinTrainsPerRoute(0, 6000), 6);
});

test('calendar starts on January 1 and applies route-level surge service planning', () => {
  const calendar = calendarState(8 * 60 + 20);
  assert.equal(calendar.dateIso, '2026-01-01');
  assert.equal(calendar.label, 'New Year travel surge');
  assert.ok(calendar.demandMultiplier > 1);
  assert.ok(calendar.priceSurgeMultiplier > 1);

  const routes = Array.from({ length: 12 }, (_, index) => ({
    ...route,
    id: `calendar-${index}`,
    code: `G${900 + index}`,
    corridor: 'East China / North China',
    originProvince: '北京',
    destinationProvince: '上海',
    frequencyRank: index < 3 ? 0.95 : 0.18,
  }));
  const engine = new SimulationEngine({ routes, seed: 22, maxTrains: 240 });
  const snapshot = engine.snapshot();
  assert.equal(snapshot.calendar.dateIso, '2026-01-01');
  assert.equal(snapshot.stats.minTrainsPerRoute >= 2, true);
  assert.equal(snapshot.stats.maxTrainsPerRoute > snapshot.stats.minTrainsPerRoute, true);
  assert.ok(snapshot.stats.trainsPerRoute > 2);
});

test('engine rolls detailed services forward across the full-year calendar', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 33, maxTrains: 8, preloadDemand: false });
  const initialTrainCount = engine.trains.length;
  assert.equal(engine.snapshot().calendar.dateIso, '2026-01-01');
  engine.setSpeed(120);
  engine.nowMinutes = 1439.25;
  engine.tick(1);
  const snapshot = engine.snapshot();

  assert.equal(snapshot.calendar.dateIso, '2026-01-02');
  assert.equal(snapshot.stats.currentServiceDayNumber, 2);
  // cumulativeTrainServices counts all trains ever created (day 1 + day 2 + ...).
  // New trains for day 2 should have departure minutes in day 2's range.
  // Retained day-1 trains and their return legs may also have departureMinute >= 1440.
  const day2TrainCount = engine.trains.filter((train) => train.departureMinute >= 1440 && train.departureMinute < 2880).length;
  assert.ok(snapshot.stats.cumulativeTrainServices >= initialTrainCount * 2, `cumulativeTrainServices ${snapshot.stats.cumulativeTrainServices} should be >= ${initialTrainCount * 2}`);
  assert.ok(day2TrainCount >= initialTrainCount, `expected at least ${initialTrainCount} trains with day-2 departure, found ${day2TrainCount}`);
  assert.ok(snapshot.bookingOptions.some((opt) => opt.serviceDate === 'Jan 2'), 'expected at least one booking option for Jan 2');
});

test('train movement is monotonic and processes every crossed station once', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 44, maxTrains: 1, preloadDemand: false });
  const departureMinute = engine.nowMinutes;
  const train = restageTrain(engine, 'r1', [3, 3, 3], { departureMinute });

  let lastProgress = -1;
  let lastDirection = 'outbound';
  for (const offset of [0, 1, 3, 4.5, 6, 8.99, 9]) {
    engine.nowMinutes = departureMinute + offset;
    engine.updateTrain(train);
    const snapshotTrain = engine.snapshot().trains.find((item) => item.id === train.id);
    const routeProgress = snapshotTrain?.routeProgress ?? 1;
    if (snapshotTrain?.direction !== lastDirection) {
      lastDirection = snapshotTrain.direction;
      lastProgress = -1;
    }
    assert.ok(routeProgress + 0.000001 >= lastProgress, `route progress regressed at offset ${offset}`);
    lastProgress = routeProgress;
  }

  assert.equal(train.completed, false);
  assert.equal(train.direction, 'return');
  assert.equal(train.status, 'scheduled');
  assert.deepEqual(train.completedLegs[0].processedStationIndexes, [0, 1, 2, 3]);
  assert.deepEqual(train.completedLegs[0].stopNames, ['A', 'B', 'C', 'D']);
  assert.deepEqual(train.stops.map((stop) => stop.name), ['D', 'C', 'B', 'A']);

  engine.nowMinutes = departureMinute + 2;
  engine.updateTrain(train);
  assert.equal(train.direction, 'return', 'return leg must not regress to outbound when the clock is moved backward');
  assert.equal(train.status, 'scheduled');
});

test('train reverses at the terminal and returns through the same stations in reverse order', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 45, maxTrains: 1, preloadDemand: false });
  const departureMinute = engine.nowMinutes;
  const train = restageTrain(engine, 'r1', [2, 2, 2], { departureMinute });

  engine.nowMinutes = departureMinute + 6;
  engine.updateTrain(train);
  assert.equal(train.direction, 'return');
  assert.equal(train.routeVariantId, 'r1:return');
  assert.equal(train.origin, 'D');
  assert.equal(train.destination, 'A');
  assert.deepEqual(train.stops.map((stop) => stop.name), ['D', 'C', 'B', 'A']);
  assert.deepEqual(train.segments.map((segment) => `${segment.from}->${segment.to}`), ['D->C', 'C->B', 'B->A']);
  assert.equal(train.status, 'scheduled');
  assert.equal(train.departureMinute, departureMinute + 7);

  engine.nowMinutes = departureMinute + 7;
  engine.updateTrain(train);
  assert.equal(train.status, 'running');
  assert.deepEqual([...train.processedStationIndexes], [0]);

  engine.nowMinutes = departureMinute + 13;
  engine.updateTrain(train);
  assert.equal(train.completed, true);
  assert.equal(train.status, 'completed');
  assert.equal(train.direction, 'return');
  assert.deepEqual(train.completedLegs.map((leg) => leg.direction), ['outbound', 'return']);
  assert.deepEqual(train.completedLegs[1].stopNames, ['D', 'C', 'B', 'A']);
  assert.deepEqual(train.completedLegs[1].processedStationIndexes, [0, 1, 2, 3]);

  const snapshotTrain = engine.snapshot().trains.find((item) => item.id === train.id);
  assert.equal(snapshotTrain.direction, 'return');
  assert.equal(snapshotTrain.currentStation, 'A');
  assert.equal(snapshotTrain.nextStation, 'A');
  assert.equal(snapshotTrain.routeProgress, 1);
});

test('no-show passengers release their seat inventory after departure', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 3, maxTrains: 1 });
  const train = restageTrain(engine, 'r1', [3, 3, 3], { departureMinute: engine.nowMinutes - 1 });

  const response = engine.bookTrip({ trainId: 'r1', originIndex: 0, destinationIndex: 2, seatClass: 'secondClass', passengerName: 'No Show' });
  assert.equal(response.ok, true);
  response.booking.noShow = true;

  const seatId = response.booking.seats[0].seatId;
  assert.equal(train.inventory.isSeatAvailable(seatId, 0, 2), false);

  engine.updateTrain(train);

  assert.equal(response.booking.status, 'noShow');
  assert.equal(train.inventory.isSeatAvailable(seatId, 0, 2), true);
  assert.equal(engine.stats.noShows >= 1, true);
});

test('live demand changes revenue and passenger totals during ticks', () => {
  const routes = Array.from({ length: 8 }, (_, index) => ({
    ...route,
    id: `live-${index}`,
    code: `G${800 + index}`,
    corridor: 'East China / North China',
    originProvince: '北京',
    destinationProvince: '上海',
    frequencyRank: 0.9,
  }));
  const engine = new SimulationEngine({ routes, seed: 4, maxTrains: 12 });
  const before = engine.snapshot().stats;
  for (let i = 0; i < 16; i += 1) engine.tick(1);
  const after = engine.snapshot().stats;

  assert.ok(after.totalRevenue > before.totalRevenue, `expected revenue to increase from ${before.totalRevenue}, saw ${after.totalRevenue}`);
  assert.ok(after.totalPassengers > before.totalPassengers, `expected passengers to increase from ${before.totalPassengers}, saw ${after.totalPassengers}`);
});
