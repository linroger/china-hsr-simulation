import { SEAT_CLASSES } from './seatInventory.js';

const BASE_SECOND_CLASS_YUAN_PER_KM = 0.46;

export function priceQuote({
  distanceKm,
  seatClass,
  loadFactor,
  hoursToDeparture,
  departureHour,
  frequencyRank = 0.5,
  noShowRisk = 0.035,
  elasticity = -1.25,
  surgeMultiplier = 1,
  bookingVelocity = 0,
}) {
  const config = SEAT_CLASSES[seatClass];
  if (!config) throw new Error(`Unknown seat class: ${seatClass}`);
  const distanceDiscount = distanceKm > 1200 ? 0.88 : distanceKm > 800 ? 0.92 : distanceKm > 500 ? 0.96 : 1;
  const baseFare = distanceKm * BASE_SECOND_CLASS_YUAN_PER_KM * config.multiplier * distanceDiscount;
  const scarcity = 1 + sigmoid((loadFactor - 0.62) * 7) * 0.48;
  const timePressure = hoursToDeparture < 2 ? 1.32 : hoursToDeparture < 8 ? 1.18 : hoursToDeparture < 24 ? 1.08 : hoursToDeparture > 168 ? 0.9 : 1;
  const peak = departureHour >= 7 && departureHour <= 9 || departureHour >= 17 && departureHour <= 20 ? 1.16 : 1;
  const frequencyRelief = 1 - Math.min(0.14, Math.max(0, frequencyRank) * 0.14);
  const noShowBuffer = 1 + Math.min(0.06, noShowRisk);
  const bidPrice = distanceKm * BASE_SECOND_CLASS_YUAN_PER_KM * Math.pow(Math.max(0.03, loadFactor), 1.8) * config.multiplier * 0.42;
  const velocityMultiplier = 1 + Math.min(0.3, bookingVelocity * 0.05);
  const expectedDemandLift = Math.exp(elasticity * Math.log(Math.max(0.7, scarcity * timePressure * velocityMultiplier)));
  const raw = (baseFare + bidPrice) * scarcity * timePressure * peak * frequencyRelief * noShowBuffer * velocityMultiplier * Math.max(0.8, surgeMultiplier);
  return {
    price: roundToNearest(Math.max(5, raw), 5),
    baseFare: roundToNearest(baseFare, 1),
    bidPrice: roundToNearest(bidPrice, 1),
    loadFactor,
    multipliers: {
      scarcity: round(scarcity),
      timePressure: round(timePressure),
      peak: round(peak),
      frequencyRelief: round(frequencyRelief),
      noShowBuffer: round(noShowBuffer),
      velocity: round(velocityMultiplier),
      surge: round(surgeMultiplier),
    },
    elasticity,
    expectedDemandLift: round(expectedDemandLift),
  };
}

export function reconcileDemandForecast({ routeDistanceKm, segmentLoad, dayOfWeek, hour, stationTier, calendarDemand = 1 }) {
  const weekend = dayOfWeek === 0 || dayOfWeek === 6 ? 1.1 : 1;
  const peak = hour >= 7 && hour <= 9 || hour >= 17 && hour <= 20 ? 1.25 : 1;
  const hub = stationTier === 'national-hub' ? 1.22 : stationTier === 'regional-hub' ? 1.1 : 1;
  const distance = routeDistanceKm > 900 ? 0.92 : routeDistanceKm > 350 ? 1.08 : 1;
  const pressure = 0.65 + segmentLoad * 0.7;
  return round(weekend * peak * hub * distance * pressure * calendarDemand);
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function roundToNearest(value, nearest) {
  return Math.round(value / nearest) * nearest;
}
