import { SeatInventory, CLASS_ORDER } from '../algorithms/seatInventory.js';
import { priceQuote, reconcileDemandForecast } from '../algorithms/pricing.js';
import { haversineKm, interpolateCoord } from './geo.js';

const DEFAULT_SPEED_KMH = 285;

export class SimulationEngine {
  constructor({ stations = [], routes = [], seed = 20260502 } = {}) {
    this.seed = seed;
    this.stations = stations;
    this.routes = routes;
    this.trains = routes.slice(0, 120).map((route, index) => this.createTrain(route, index));
    this.bookings = [];
    this.events = [];
    this.nowMinutes = 6 * 60;
    this.running = false;
    this.speed = 10;
    this.callbacks = { onUpdate: null };
    this.stats = { totalRevenue: 0, totalBookings: 0, rejectedBookings: 0, totalPassengers: 0 };
    this.preloadDemand();
  }

  createTrain(route, index) {
    const inventory = new SeatInventory(route.stops);
    const departureMinute = 6 * 60 + (index % 48) * 12;
    const segmentMinutes = route.segments.map((segment) => Math.max(8, Math.round((segment.distanceKm / DEFAULT_SPEED_KMH) * 60 + 3)));
    return {
      id: route.id,
      code: route.code,
      type: route.type,
      origin: route.origin,
      destination: route.destination,
      stops: route.stops,
      segments: route.segments,
      totalDistanceKm: route.totalDistanceKm,
      inventory,
      departureMinute,
      segmentMinutes,
      status: 'scheduled',
      currentSegmentIndex: 0,
      segmentProgress: 0,
      completed: false,
      bookings: [],
      algorithmMetrics: [],
    };
  }

  preloadDemand() {
    for (const train of this.trains.slice(0, 40)) {
      const attempts = 10 + (hashCode(train.code) % 25);
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
    train.status = 'running';
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
      const station = train.stops[segmentIndex]?.name;
      const alighting = train.bookings.filter((booking) => booking.destinationIndex === segmentIndex).length;
      const boarding = train.bookings.filter((booking) => booking.originIndex === segmentIndex).length;
      this.logEvent('station', `${train.code} stopped at ${station}: ${boarding} boarding, ${alighting} alighting.`);
    }
    train.currentSegmentIndex = segmentIndex;
    train.segmentProgress = elapsed / train.segmentMinutes[segmentIndex];
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
    const train = this.trains.find((item) => item.id === trainId);
    if (!train) throw new Error(`Unknown train: ${trainId}`);
    return train;
  }

  logEvent(type, message) {
    this.events.unshift({ id: `${Date.now()}-${this.events.length}`, type, message, minute: Math.round(this.nowMinutes) });
    this.events = this.events.slice(0, 80);
  }

  snapshot() {
    return {
      nowMinutes: Math.round(this.nowMinutes),
      stats: { ...this.stats },
      bookings: this.bookings.slice(-12).reverse(),
      events: this.events,
      trains: this.trains.map((train) => serializeTrain(train, this.nowMinutes)),
    };
  }

  random(...parts) {
    return seeded(`${this.seed}:${parts.join(':')}`);
  }
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
    minutesToDeparture: Math.round(train.departureMinute - nowMinutes),
  };
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
