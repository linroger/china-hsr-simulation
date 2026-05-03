import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarState, SimulationEngine } from '../src/simulation_core/SimulationEngine.js';

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

  assert.equal(engine.trains.length, 40);
  assert.equal(snapshot.bookingOptions.length, 40);
  assert.equal(snapshot.stats.minTrainsPerRoute, 2);
  assert.ok(snapshot.network.corridors.length >= 2);
  assert.ok(snapshot.stats.averageDelayMinutes > 0);
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
  assert.ok(snapshot.stats.cumulativeTrainServices >= initialTrainCount + engine.trains.length);
  assert.ok(engine.trains.every((train) => train.departureMinute >= 1440 && train.departureMinute < 2880));
  assert.equal(snapshot.bookingOptions[0].serviceDate, 'Jan 2');
});

test('no-show passengers release their seat inventory after departure', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 3, maxTrains: 1 });
  const train = engine.getTrain('r1');
  train.departureMinute = engine.nowMinutes - 1;
  train.status = 'scheduled';
  train.processedStationIndexes = new Set();

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
