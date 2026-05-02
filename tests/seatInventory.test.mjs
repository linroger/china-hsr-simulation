import assert from 'node:assert/strict';
import test from 'node:test';
import { SeatInventory } from '../src/algorithms/seatInventory.js';

const routeStations = [
  { name: 'A' },
  { name: 'B' },
  { name: 'C' },
  { name: 'D' },
];

test('same seat is reusable after passenger alights but blocked for overlapping intervals', () => {
  const inventory = new SeatInventory(routeStations, [
    { id: 'S1', seatClass: 'secondClass', car: 1, row: 1, letter: 'A', position: 'window', accessible: false, intervals: [] },
  ]);

  const first = inventory.allocate({ originIndex: 0, destinationIndex: 2, seatClass: 'secondClass', passengerId: 'p1', ticketId: 't1' });
  assert.equal(first[0].seatId, 'S1');
  assert.equal(inventory.isSeatAvailable('S1', 1, 3), false);

  const overlap = inventory.allocate({ originIndex: 1, destinationIndex: 3, seatClass: 'secondClass', passengerId: 'p2', ticketId: 't2' });
  assert.equal(overlap, null);

  const afterAlight = inventory.allocate({ originIndex: 2, destinationIndex: 3, seatClass: 'secondClass', passengerId: 'p3', ticketId: 't3' });
  assert.equal(afterAlight[0].seatId, 'S1');
  assert.deepEqual(inventory.seatTimeline('S1').map((item) => [item.origin, item.destination]), [['A', 'C'], ['C', 'D']]);
});
