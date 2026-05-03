import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulationEngine } from '../src/simulation_core/SimulationEngine.js';

const route = {
  id: 'ledger-route',
  code: 'G2001',
  type: 'G',
  origin: 'A',
  destination: 'D',
  totalDistanceKm: 300,
  frequencyRank: 0.7,
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

test('booking ledger captures every confirmed booking with rich metadata', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 9, preloadDemand: false });

  const a = engine.bookTrip({ trainId: 'ledger-route', originIndex: 0, destinationIndex: 2, seatClass: 'secondClass', passengerName: 'Alpha' });
  const b = engine.bookTrip({ trainId: 'ledger-route', originIndex: 1, destinationIndex: 3, seatClass: 'firstClass', passengerName: 'Bravo' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const drained = engine.drainLedger();
  assert.equal(drained.length >= 2, true, 'expected at least 2 ledger entries');

  const first = drained.find((entry) => entry.ticketId === a.booking.ticketId);
  assert.ok(first, 'first booking should be recorded');
  assert.equal(first.status, 'confirmed');
  assert.equal(first.origin, 'A');
  assert.equal(first.destination, 'C');
  assert.equal(first.seatClass, 'secondClass');
  assert.ok(Array.isArray(first.seats) && first.seats.length >= 1);
  assert.ok(first.bookedAtClock?.match(/^\d{2}:\d{2}$/));
  assert.equal(first.routeId, 'ledger-route');

  // After drain the ledger is empty and ready for the next batch
  assert.equal(engine.drainLedger().length, 0);
});

test('cancellations append a status=cancelled ledger entry', () => {
  const engine = new SimulationEngine({ routes: [route], seed: 10, preloadDemand: false });
  const result = engine.bookTrip({ trainId: 'ledger-route', originIndex: 0, destinationIndex: 1, seatClass: 'secondClass' });
  assert.equal(result.ok, true);
  engine.drainLedger(); // clear booking entry

  const cancelled = engine.cancelBooking(result.booking.ticketId);
  assert.equal(cancelled, true);
  const drained = engine.drainLedger();
  const cancelEntry = drained.find((entry) => entry.ticketId === result.booking.ticketId);
  assert.ok(cancelEntry, 'cancellation must produce a ledger entry');
  assert.equal(cancelEntry.status, 'cancelled');
});
