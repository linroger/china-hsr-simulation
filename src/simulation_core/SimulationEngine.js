import { SeatInventory, CLASS_ORDER } from '../algorithms/seatInventory.js';
import { priceQuote, reconcileDemandForecast } from '../algorithms/pricing.js';
import { haversineKm, interpolateCoord } from './geo.js';

const DEFAULT_SPEED_KMH = 285;
const DEFAULT_MAX_TRAINS = 1500;
const SNAPSHOT_TRAIN_LIMIT = 700;

export class SimulationEngine {
  constructor({ stations = [], routes = [], seed = 20260502, maxTrains = DEFAULT_MAX_TRAINS } = {}) {
    this.seed = seed;
    this.stations = stations;
    this.routes = routes;
    this.trains = this.createScheduledServices(routes, maxTrains);
    this.trainById = new Map(this.trains.map((train) => [train.id, train]));
    this.bookings = [];
    this.events = [];
    this.nowMinutes = 8 * 60 + 20;
    this.running = false;
    this.speed = 10;
    this.callbacks = { onUpdate: null };
    this.stats = { totalRevenue: 0, totalBookings: 0, rejectedBookings: 0, totalPassengers: 0, noShows: 0, stationStops: 0, trainCount: this.trains.length };
    this.preloadDemand();
    this.tick(0);
  }

  createScheduledServices(routes, maxTrains) {
    if (!routes.length) return [];
    const trains = [];
    const serviceCount = Math.min(maxTrains, Math.max(routes.length, Math.ceil(routes.length * 1.5)));
    for (let index = 0; index < serviceCount; index += 1) {
      const route = routes[index % routes.length];
      const cycle = Math.floor(index / routes.length);
      trains.push(this.createTrain(route, index, cycle));
    }
    return trains;
  }

  createTrain(route, index, cycle = 0) {
    const inventory = new SeatInventory(route.stops);
    const departureMinute = scheduledDepartureMinute(route, index, cycle);
    const plannedRuntimes = route.segments.map((segment, segmentIndex) => plannedSegmentMinutes(route, segment, segmentIndex));
    const segmentMinutes = route.segments.map((segment, segmentIndex) => realisticSegmentMinutes(route, segment, segmentIndex, index, cycle));
    const serviceSuffix = cycle > 0 ? `-${cycle + 1}` : '';
    const delayMinutes = Math.max(0, Math.round(segmentMinutes.reduce((sum, minutes) => sum + minutes, 0) - plannedRuntimes.reduce((sum, minutes) => sum + minutes, 0)));
    return {
      id: `${route.id}${serviceSuffix}`,
      routeId: route.id,
      code: cycle > 0 ? `${route.code}.${cycle + 1}` : route.code,
      type: route.type,
      origin: route.origin,
      destination: route.destination,
      originProvince: route.originProvince,
      destinationProvince: route.destinationProvince,
      corridor: route.corridor,
      stops: route.stops,
      segments: route.segments,
      totalDistanceKm: route.totalDistanceKm,
      frequencyRank: route.frequencyRank,
      inventory,
      departureMinute,
      segmentMinutes,
      plannedSegmentMinutes: plannedRuntimes,
      delayMinutes,
      status: 'scheduled',
      currentSegmentIndex: 0,
      segmentProgress: 0,
      processedStationIndexes: new Set(),
      completed: false,
      bookings: [],
      algorithmMetrics: [],
    };
  }

  preloadDemand() {
    for (const train of this.trains) {
      const demandIntensity = train.frequencyRank > 0.5 ? 1.2 : train.corridor?.includes('North China') || train.corridor?.includes('East China') ? 1.05 : 0.82;
      const attempts = Math.max(4, Math.round((6 + (Math.abs(hashCode(train.id)) % 18)) * demandIntensity));
      for (let i = 0; i < attempts; i += 1) {
        const originIndex = Math.floor(this.random(train.id, i) * Math.max(1, train.stops.length - 2));
        const maxDest = train.stops.length - 1;
        const destinationIndex = Math.min(maxDest, originIndex + 1 + Math.floor(this.random(train.id, i, 'd') * Math.min(5, maxDest - originIndex)));
        const seatClass = weightedClass(this.random(train.id, i, 'c'));
        this.bookTrip({
          trainId: train.id,
          originIndex,
          destinationIndex,
          seatClass,
          passengerName: `Sim Pax ${i + 1}`,
          silent: true,
        });
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  setSpeed(speed) {
    this.speed = Math.max(1, Math.min(120, speed));
  }

  loop() {
    if (!this.running) return;
    this.tick(1);
    this.callbacks.onUpdate?.(this.snapshot());
    this.timer = setTimeout(() => this.loop(), 1000 / 20);
  }

  tick(realSeconds = 1) {
    this.nowMinutes += realSeconds * this.speed / 60;
    for (const train of this.trains) this.updateTrain(train);
  }

  updateTrain(train) {
    if (train.completed) return;
    if (this.nowMinutes < train.departureMinute) return;
    const wasScheduled = train.status === 'scheduled';
    train.status = 'running';
    if (wasScheduled) this.processStation(train, 0);
    let elapsed = this.nowMinutes - train.departureMinute;
    let segmentIndex = 0;
    while (segmentIndex < train.segmentMinutes.length && elapsed > train.segmentMinutes[segmentIndex]) {
      elapsed -= train.segmentMinutes[segmentIndex];
      segmentIndex += 1;
    }
    if (segmentIndex >= train.segmentMinutes.length) {
      train.completed = true;
      train.status = 'completed';
      train.currentSegmentIndex = train.segmentMinutes.length - 1;
      train.segmentProgress = 1;
      this.logEvent('arrival', `${train.code} completed ${train.origin} to ${train.destination}.`);
      return;
    }
    if (segmentIndex !== train.currentSegmentIndex) {
      this.processStation(train, segmentIndex);
    }
    train.currentSegmentIndex = segmentIndex;
    train.segmentProgress = elapsed / train.segmentMinutes[segmentIndex];
  }

  processStation(train, stationIndex) {
    if (train.processedStationIndexes.has(stationIndex)) return;
    train.processedStationIndexes.add(stationIndex);
    const station = train.stops[stationIndex]?.name;
    let boarding = 0;
    let alighting = 0;
    let noShows = 0;
    for (const booking of train.bookings) {
      const seatCount = booking.seats?.length || 1;
      if (booking.originIndex === stationIndex && booking.status === 'confirmed') {
        if (booking.noShow) {
          train.inventory.releaseTicket(booking.ticketId);
          booking.status = 'noShow';
          noShows += seatCount;
          this.stats.noShows += seatCount;
        } else {
          booking.status = 'onboard';
          boarding += seatCount;
        }
      }
      if (booking.destinationIndex === stationIndex && booking.status === 'onboard') {
        booking.status = 'completed';
        alighting += seatCount;
      }
    }
    this.stats.stationStops += 1;
    this.logEvent('station', `${train.code} stopped at ${station}: ${boarding} boarded, ${alighting} alighted${noShows ? `, ${noShows} no-show release` : ''}.`);
  }

  quoteTrip({ trainId, originIndex, destinationIndex, seatClass = 'secondClass', groupSize = 1 }) {
    const train = this.getTrain(trainId);
    const started = performance.now();
    train.inventory.validateInterval(originIndex, destinationIndex);
    const availability = train.inventory.availableSeats({ originIndex, destinationIndex, seatClass }).length;
    const distanceKm = distanceBetween(train, originIndex, destinationIndex);
    const load = train.inventory.maxLoad(originIndex, destinationIndex, seatClass);
    const departureHour = Math.floor(train.departureMinute / 60) % 24;
    const hoursToDeparture = Math.max(0.2, (train.departureMinute - this.nowMinutes) / 60);
    const forecast = reconcileDemandForecast({
      routeDistanceKm: distanceKm,
      segmentLoad: load.loadFactor,
      dayOfWeek: 5,
      hour: departureHour,
      stationTier: train.stops[originIndex]?.tier,
    });
    const pricing = priceQuote({
      distanceKm,
      seatClass,
      loadFactor: Math.min(0.99, load.loadFactor * forecast),
      hoursToDeparture,
      departureHour,
      frequencyRank: train.frequencyRank || 0.5,
      noShowRisk: 0.025 + Math.min(0.04, load.loadFactor * 0.04),
    });
    const elapsedMs = performance.now() - started;
    return {
      trainId,
      trainCode: train.code,
      originIndex,
      destinationIndex,
      origin: train.stops[originIndex].name,
      destination: train.stops[destinationIndex].name,
      seatClass,
      groupSize,
      available: availability,
      canBook: availability >= groupSize,
      distanceKm: Math.round(distanceKm),
      pricing,
      algorithmMs: Math.round(elapsedMs * 1000) / 1000,
    };
  }

  bookTrip({ trainId, originIndex, destinationIndex, seatClass = 'secondClass', passengerName = 'Passenger', preference = 'any', accessible = false, groupSize = 1, silent = false }) {
    const quote = this.quoteTrip({ trainId, originIndex, destinationIndex, seatClass, groupSize });
    const train = this.getTrain(trainId);
    if (!quote.canBook) {
      this.stats.rejectedBookings += 1;
      return { ok: false, reason: 'No seats available for the requested interval.', quote };
    }
    const ticketId = `T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
    const passengerId = `P${ticketId.slice(1)}`;
    const assignedSeats = train.inventory.allocate({
      originIndex,
      destinationIndex,
      seatClass,
      passengerId,
      ticketId,
      preference,
      accessible,
      groupSize,
    });
    if (!assignedSeats) {
      this.stats.rejectedBookings += 1;
      return { ok: false, reason: 'Allocation failed after quote because the seat calendar changed.', quote };
    }
    const booking = {
      ticketId,
      passengerId,
      passengerName,
      trainId,
      trainCode: train.code,
      originIndex,
      destinationIndex,
      origin: quote.origin,
      destination: quote.destination,
      seatClass,
      seats: assignedSeats,
      price: quote.pricing.price * groupSize,
      distanceKm: quote.distanceKm,
      bookedAtMinute: this.nowMinutes,
      status: 'confirmed',
      noShow: this.random(trainId, originIndex, destinationIndex, this.stats.totalBookings, 'noShow') < noShowProbability(train, originIndex, seatClass),
    };
    train.bookings.push(booking);
    this.bookings.push(booking);
    this.stats.totalRevenue += booking.price;
    this.stats.totalBookings += 1;
    this.stats.totalPassengers += groupSize;
    if (!silent) this.logEvent('booking', `${booking.trainCode} ${booking.origin} to ${booking.destination}: ${assignedSeats.map((s) => `${s.car}-${s.row}${s.letter}`).join(', ')} for ¥${booking.price}.`);
    return { ok: true, booking, quote };
  }

  cancelBooking(ticketId) {
    const booking = this.bookings.find((item) => item.ticketId === ticketId);
    if (!booking) return false;
    const train = this.getTrain(booking.trainId);
    train.inventory.releaseTicket(ticketId);
    train.bookings = train.bookings.filter((item) => item.ticketId !== ticketId);
    this.bookings = this.bookings.filter((item) => item.ticketId !== ticketId);
    this.logEvent('release', `${booking.trainCode} released ${booking.seats.length} seat(s) after cancellation or alighting logic.`);
    return true;
  }

  getTrain(trainId) {
    const train = this.trainById.get(trainId);
    if (!train) throw new Error(`Unknown train: ${trainId}`);
    return train;
  }

  logEvent(type, message) {
    this.events.unshift({ id: `${Date.now()}-${this.events.length}`, type, message, minute: Math.round(this.nowMinutes) });
    this.events = this.events.slice(0, 80);
  }

  snapshot() {
    const serialized = this.trains.map((train) => serializeTrain(train, this.nowMinutes));
    const visibleTrains = selectVisibleTrains(serialized, SNAPSHOT_TRAIN_LIMIT);
    return {
      nowMinutes: Math.round(this.nowMinutes),
      stats: {
        ...this.stats,
        activeTrains: serialized.filter((train) => train.status === 'running').length,
        scheduledTrains: serialized.filter((train) => train.status === 'scheduled').length,
        completedTrains: serialized.filter((train) => train.status === 'completed').length,
        visibleTrainCount: visibleTrains.length,
        averageDelayMinutes: average(serialized.map((train) => train.delayMinutes || 0)),
        delayedTrains: serialized.filter((train) => (train.delayMinutes || 0) >= 5).length,
      },
      bookings: this.bookings.slice(-12).reverse(),
      events: this.events,
      trains: visibleTrains,
      bookingOptions: this.trains.map((train) => ({
        id: train.id,
        code: train.code,
        routeId: train.routeId,
        origin: train.origin,
        destination: train.destination,
        corridor: train.corridor,
        originProvince: train.originProvince,
        destinationProvince: train.destinationProvince,
        stops: train.stops.map((stop, index) => ({ ...stop, index })),
        departureMinute: train.departureMinute,
        totalDistanceKm: train.totalDistanceKm,
      })),
      network: networkSummary(serialized),
    };
  }

  random(...parts) {
    return seeded(`${this.seed}:${parts.join(':')}`);
  }
}

function plannedSegmentMinutes(route, segment, segmentIndex) {
  const dwell = route.stops[segmentIndex + 1]?.dwellMinutes || 2;
  const speed = Math.min(segment.speedLimitKmh || DEFAULT_SPEED_KMH, DEFAULT_SPEED_KMH);
  return Math.max(8, Math.round((segment.distanceKm / speed) * 60 + dwell));
}

function realisticSegmentMinutes(route, segment, segmentIndex, trainIndex, cycle) {
  const planned = plannedSegmentMinutes(route, segment, segmentIndex);
  const nextStop = route.stops[segmentIndex + 1];
  const hubPressure = nextStop?.tier === 'national-hub' ? 3 : nextStop?.tier === 'regional-hub' ? 1.5 : 0.4;
  const weatherDrag = deterministicNoise(`${route.id}:${trainIndex}:${cycle}:${segmentIndex}:weather`) > 0.94 ? 4 : 0;
  const dispatchSlack = deterministicNoise(`${route.id}:${trainIndex}:${cycle}:${segmentIndex}:dispatch`) > 0.86 ? 2 : 0;
  return Math.round(planned + hubPressure + weatherDrag + dispatchSlack);
}

function noShowProbability(train, originIndex, seatClass) {
  const station = train.stops[originIndex];
  const base = seatClass === 'business' ? 0.018 : seatClass === 'firstClass' ? 0.026 : 0.038;
  const hubAdjustment = station?.tier === 'national-hub' ? -0.006 : station?.tier === 'local' ? 0.008 : 0;
  const shortHopAdjustment = train.stops.length <= 4 ? 0.006 : 0;
  return Math.max(0.01, Math.min(0.08, base + hubAdjustment + shortHopAdjustment));
}

function scheduledDepartureMinute(route, index, cycle) {
  const hash = Math.abs(hashCode(`${route.id}:${route.code}`));
  const trunkBias = route.frequencyRank > 0.55 ? -35 : route.frequencyRank > 0.25 ? -10 : 12;
  const windowStart = 5 * 60 + 20;
  const windowMinutes = 15 * 60;
  const offset = (hash * 7 + index * 11 + cycle * 137) % windowMinutes;
  return windowStart + offset + trunkBias;
}

function selectVisibleTrains(trains, limit) {
  const active = trains.filter((train) => train.status === 'running');
  const scheduled = trains.filter((train) => train.status === 'scheduled' && train.minutesToDeparture <= 120);
  const completed = trains.filter((train) => train.status === 'completed').slice(-60);
  return [...active, ...scheduled, ...completed]
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || Math.abs(a.minutesToDeparture) - Math.abs(b.minutesToDeparture))
    .slice(0, limit);
}

function statusRank(status) {
  if (status === 'running') return 0;
  if (status === 'scheduled') return 1;
  return 2;
}

function networkSummary(trains) {
  const byCorridor = new Map();
  const byProvince = new Map();
  const byStation = new Map();
  for (const train of trains) {
    increment(byCorridor, train.corridor || 'Unknown', train);
    increment(byProvince, train.originProvince || 'Unknown', train);
    if (train.status === 'running') increment(byStation, train.currentStation || 'Unknown', train);
  }
  return {
    corridors: [...byCorridor.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.trains - a.trains),
    originProvinces: [...byProvince.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.trains - a.trains),
    stationHotspots: [...byStation.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.active - a.active || b.passengers - a.passengers).slice(0, 16),
  };
}

function increment(map, key, train) {
  if (!map.has(key)) map.set(key, { trains: 0, active: 0, passengers: 0 });
  const value = map.get(key);
  value.trains += 1;
  if (train.status === 'running') value.active += 1;
  value.passengers += train.passengerCount || 0;
}

function serializeTrain(train, nowMinutes) {
  const from = train.stops[train.currentSegmentIndex] || train.stops[0];
  const to = train.stops[train.currentSegmentIndex + 1] || from;
  const coords = interpolateCoord(from, to, train.segmentProgress || 0);
  const activeLoad = train.inventory.occupancyForSegment(train.currentSegmentIndex);
  const classLoads = Object.fromEntries(CLASS_ORDER.map((seatClass) => [seatClass, train.inventory.occupancyForSegment(train.currentSegmentIndex, seatClass)]));
  return {
    id: train.id,
    code: train.code,
    type: train.type,
    origin: train.origin,
    destination: train.destination,
    originProvince: train.originProvince,
    destinationProvince: train.destinationProvince,
    corridor: train.corridor,
    currentStation: from.name,
    nextStation: to.name,
    coords,
    status: train.status,
    currentSegmentIndex: train.currentSegmentIndex,
    progress: train.segmentProgress,
    loadFactor: activeLoad.loadFactor,
    passengerCount: activeLoad.occupied,
    capacity: activeLoad.capacity,
    occupancy: Object.fromEntries(Object.entries(classLoads).map(([key, value]) => [key, value.occupied])),
    classLoads,
    stops: train.stops.map((stop, index) => ({ ...stop, index })),
    totalDistanceKm: train.totalDistanceKm,
    departureMinute: train.departureMinute,
    delayMinutes: train.delayMinutes,
    minutesToDeparture: Math.round(train.departureMinute - nowMinutes),
  };
}

function average(values) {
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function distanceBetween(train, originIndex, destinationIndex) {
  let total = 0;
  for (let index = originIndex; index < destinationIndex; index += 1) {
    total += train.segments[index]?.distanceKm || haversineKm(train.stops[index], train.stops[index + 1]);
  }
  return total;
}

function weightedClass(value) {
  if (value < 0.04) return 'business';
  if (value < 0.22) return 'firstClass';
  return 'secondClass';
}

function hashCode(value) {
  return [...String(value)].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0);
}

function seeded(key) {
  let hash = 2166136261;
  for (const char of key) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000000) / 1000000;
}

function deterministicNoise(key) {
  return seeded(`noise:${key}`);
}
