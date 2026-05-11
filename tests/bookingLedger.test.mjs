import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SimulationEngine } from '../src/simulation_core/SimulationEngine.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

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

test('OceanBase booking ingest dry-run validates rows and skips malformed ledger entries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinahsr-ledger-test-'));
  const inputPath = path.join(tempDir, 'bookings.ndjson');
  try {
    fs.writeFileSync(inputPath, [
      JSON.stringify({
        ticketId: 'TVALID001',
        trainId: 'G1',
        trainCode: 'G1',
        routeId: 'r1',
        passengerId: 'P1',
        passengerName: 'Alpha',
        origin: 'A',
        destination: 'B',
        originIndex: 0,
        destinationIndex: 1,
        seatClass: 'secondClass',
        seats: ['1-01A'],
        price: 88.5,
        distanceKm: 120,
        bookedAtMinute: 480,
        bookedAtClock: '08:00',
        serviceDate: '2026-01-01',
        status: 'confirmed',
      }),
      JSON.stringify({ trainId: 'missing-ticket', routeId: 'r1', origin: 'A', destination: 'B' }),
      '{not-json',
    ].join('\n') + '\n', 'utf8');

    const output = execFileSync('python3', [
      'scripts/oceanbase_booking_ingest.py',
      '--input',
      inputPath,
      '--dry-run',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.match(output, /dry-run validated 1 bookings/);
    assert.match(output, /skipped 2/);
    assert.equal(fs.existsSync(inputPath), true, 'dry-run must not delete replayable ledger files');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
