import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulationEngine } from '../src/simulation_core/SimulationEngine.js';

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
  const engine = new SimulationEngine({ routes: [route], seed: 1 });
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
