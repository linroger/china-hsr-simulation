import assert from 'node:assert/strict';
import test from 'node:test';
import { priceQuote } from '../src/algorithms/pricing.js';

test('dynamic pricing orders seat classes and rises with scarcity', () => {
  const common = { distanceKm: 900, hoursToDeparture: 5, departureHour: 8, frequencyRank: 0.3 };
  const secondLow = priceQuote({ ...common, seatClass: 'secondClass', loadFactor: 0.15 });
  const firstLow = priceQuote({ ...common, seatClass: 'firstClass', loadFactor: 0.15 });
  const businessLow = priceQuote({ ...common, seatClass: 'business', loadFactor: 0.15 });
  const secondHigh = priceQuote({ ...common, seatClass: 'secondClass', loadFactor: 0.93 });

  assert.ok(firstLow.price > secondLow.price);
  assert.ok(businessLow.price > firstLow.price);
  assert.ok(secondHigh.price > secondLow.price);
  assert.ok(secondHigh.bidPrice > secondLow.bidPrice);
});
