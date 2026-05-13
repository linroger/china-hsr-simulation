import { SeatInventory } from '../algorithms/seatInventory.js';
import { priceQuote, reconcileDemandForecast } from '../algorithms/pricing.js';
import { haversineKm, interpolateCoord, interpolateLine } from './geo.js';

const DEFAULT_SPEED_KMH = 285;
const DEFAULT_DAILY_TRAIN_BUDGET = 6000;
const MIN_DAILY_TRAINS_PER_ROUTE = 2;
const SNAPSHOT_TRAIN_LIMIT = 1500;
const TRAIN_SEAT_QUOTA = 554;
const SERVICE_YEAR_DAYS = 365;
const TERMINAL_TURNAROUND_MINUTES = 18;
const SERVICE_DAY_START_YEAR = 2026;
const SERVICE_DAY_START_MONTH = 0;
const SERVICE_DAY_START_DAY = 1;

export class SimulationEngine {
  constructor({ stations = [], routes = [], seed = 20260502, maxTrains = DEFAULT_DAILY_TRAIN_BUDGET, yearDays = SERVICE_YEAR_DAYS, preloadDemand = true } = {}) {
    this.seed = seed;
    this.stations = stations;
    this.routes = routes;
    this.nowMinutes = 8 * 60 + 20;
    this.calendar = calendarState(this.nowMinutes);
    this.currentServiceDayIndex = this.calendar.dayIndex;
    this.dailyTrainBudget = maxTrains;
    this.yearDays = yearDays;
    this.autoPreloadDemand = preloadDemand;
    this.trains = this.createScheduledServices(routes, maxTrains, this.calendar);
    this.trainById = new Map(this.trains.map((train) => [train.id, train]));
    this.bookingOptions = this.createBookingOptions();
    this.bookings = [];
    this.events = [];
    this.running = false;
    this.speed = 10;
    this.callbacks = { onUpdate: null };
    this.preloadCursor = 0;
    const routeServiceStats = summarizeRouteServices(this.trains, this.routes);
    this.stats = {
      totalRevenue: 0,
      totalBookings: 0,
      rejectedBookings: 0,
      totalPassengers: 0,
      noShows: 0,
      stationStops: 0,
      trainCount: this.trains.length,
      routeCount: this.routes.length,
      seatQuotaPerTrain: TRAIN_SEAT_QUOTA,
      cumulativeTrainServices: this.trains.length,
      currentServiceDayIndex: this.currentServiceDayIndex,
      currentServiceDayNumber: this.currentServiceDayIndex + 1,
      simulationYearDays: this.yearDays,
      detailedDayTrainBudget: this.dailyTrainBudget,
      ...routeServiceStats,
    };
    this.tickCounter = 0;
    this.lastTickMs = null;
    this.bookingCounter = 0;
    this.bookingOptionsDirty = false;
    this.bookingVelocity = new Map();
    if (preloadDemand) this.preloadDemand();
    this.tick(0);
  }

  createScheduledServices(routes, maxTrains, calendar = this.calendar) {
    if (!routes.length) return [];
    const trains = [];
    const plans = allocateDailyServices(routes, maxTrains, calendar);
    let index = 0;
    for (const plan of plans) {
      for (let serviceIndex = 0; serviceIndex < plan.serviceCount; serviceIndex += 1) {
        trains.push(this.createTrain(plan.route, index, serviceIndex, plan.serviceCount, this.calendar));
        index += 1;
      }
    }
    return trains;
  }

  createTrain(route, index, serviceIndex = 0, serviceCount = 1, calendar = this.calendar) {
    const inventory = new SeatInventory(route.stops);
    const departureMinute = calendar.dayIndex * 1440 + scheduledDepartureMinute(route, serviceIndex, serviceCount, index);
    const plannedRuntimes = route.segments.map((segment, segmentIndex) => plannedSegmentMinutes(route, segment, segmentIndex));
    const segmentMinutes = route.segments.map((segment, segmentIndex) => realisticSegmentMinutes(route, segment, segmentIndex, index, serviceIndex, calendar));
    const serviceSuffix = serviceIndex > 0 ? `-${serviceIndex + 1}` : '';
    const dayPrefix = calendar.dayIndex > 0 ? `day${calendar.dayIndex + 1}-` : '';
    const delayMinutes = Math.max(0, Math.round(segmentMinutes.reduce((sum, minutes) => sum + minutes, 0) - plannedRuntimes.reduce((sum, minutes) => sum + minutes, 0)));
    const outboundVariantId = route.routeContract?.outboundVariantId || `${route.id}:outbound`;
    const returnVariantId = route.routeContract?.returnVariantId || `${route.id}:return`;
    return {
      id: `${dayPrefix}${route.id}${serviceSuffix}`,
      routeId: route.id,
      routeVariantId: outboundVariantId,
      outboundVariantId,
      returnVariantId,
      routeStopSequenceHash: route.routeContract?.stopSequenceHash || stopSequenceHash(route.stops),
      code: serviceIndex > 0 ? `${route.code}.${serviceIndex + 1}` : route.code,
      type: route.type,
      origin: route.origin,
      destination: route.destination,
      originalOrigin: route.origin,
      originalDestination: route.destination,
      originProvince: route.originProvince,
      destinationProvince: route.destinationProvince,
      corridor: route.corridor,
      calendar,
      baseRoute: route,
      direction: 'outbound',
      legIndex: 0,
      maxLegIndex: 1,
      stops: route.stops,
      segments: route.segments,
      totalDistanceKm: route.totalDistanceKm,
      frequencyRank: route.frequencyRank,
      servicesForRoute: serviceCount,
      serviceIndexForRoute: serviceIndex,
      inventory,
      departureMinute,
      segmentMinutes,
      plannedSegmentMinutes: plannedRuntimes,
      delayMinutes,
      status: 'scheduled',
      currentSegmentIndex: 0,
      segmentProgress: 0,
      processedStationIndexes: new Set(),
      completedLegs: [],
      terminalTurnaroundMinutes: route.terminalTurnaroundMinutes || TERMINAL_TURNAROUND_MINUTES,
      turnaroundDepartureMinute: null,
      completed: false,
      bookings: [],
      algorithmMetrics: [],
    };
  }

  preloadDemand() {
    while (this.preloadCursor < this.trains.length) {
      this.preloadTrainDemand(this.trains[this.preloadCursor]);
      this.preloadCursor += 1;
    }
  }

  preloadDemandBatch(trainBatchSize = 80) {
    let processed = 0;
    while (processed < trainBatchSize && this.preloadCursor < this.trains.length) {
      this.preloadTrainDemand(this.trains[this.preloadCursor]);
      this.preloadCursor += 1;
      processed += 1;
    }
    return {
      processed,
      done: this.preloadCursor >= this.trains.length,
      progress: this.trains.length ? Math.round((this.preloadCursor / this.trains.length) * 1000) / 10 : 100,
    };
  }

  hasPendingDemandPreload() {
    return this.preloadCursor < this.trains.length;
  }

  preloadTrainDemand(train) {
    const demandIntensity = routeDemandIntensity(train);
    const calendarDemand = train.calendar?.demandMultiplier || this.calendar.demandMultiplier || 1;
    const targetLoad = Math.min(0.96, 0.58 + demandIntensity * 0.16 + (calendarDemand - 1) * 0.14 + this.random(train.id, 'load') * 0.12);
    const targetPassengers = Math.round(TRAIN_SEAT_QUOTA * targetLoad);
    const attempts = Math.max(42, Math.round(targetPassengers / 4.15));
    let bookedPassengers = 0;
    for (let i = 0; i < attempts && bookedPassengers < targetPassengers; i += 1) {
      const originIndex = Math.floor(this.random(train.id, i) * Math.max(1, train.stops.length - 2));
      const maxDest = train.stops.length - 1;
      const destinationIndex = Math.min(maxDest, originIndex + 1 + Math.floor(this.random(train.id, i, 'd') * Math.min(5, maxDest - originIndex)));
      const seatClass = weightedClass(this.random(train.id, i, 'c'));
      const remaining = Math.max(1, targetPassengers - bookedPassengers);
      const groupSize = Math.min(6, remaining, groupSizeFromRandom(this.random(train.id, i, 'g')));
      const response = this.bookTrip({
        trainId: train.id,
        originIndex,
        destinationIndex,
        seatClass,
        groupSize,
        passengerName: `Sim Pax ${i + 1}`,
        silent: true,
      });
      if (response.ok) bookedPassengers += groupSize;
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
    const nowMs = performance.now();
    const elapsedSec = this.lastTickMs ? Math.min(0.5, (nowMs - this.lastTickMs) / 1000) : 0.1;
    this.lastTickMs = nowMs;
    this.tick(elapsedSec);
    if (this.callbacks.onUpdate) this.callbacks.onUpdate(this.snapshot());
    this.timer = setTimeout(() => this.loop(), 1000 / 20);
  }

  tick(realSeconds = 1) {
    if (this.stats.fullYearCompleted) return;
    const previousMinute = Math.floor(this.nowMinutes);
    this.nowMinutes += realSeconds * this.speed / 60;
    const currentMinute = Math.floor(this.nowMinutes);
    if (currentMinute !== previousMinute) {
      // Decay booking velocity every simulated minute
      for (const [routeId, velocity] of this.bookingVelocity) {
        const decayed = velocity * 0.95;
        if (decayed < 0.1) this.bookingVelocity.delete(routeId);
        else this.bookingVelocity.set(routeId, decayed);
      }
    }
    this.calendar = calendarState(this.nowMinutes);
    if (this.calendar.dayIndex >= this.yearDays) {
      this.stats.fullYearCompleted = true;
      this.nowMinutes = this.yearDays * 1440 - 1;
      this.calendar = calendarState(this.nowMinutes);
      // Run final-day processing: complete all running trains.
      for (const train of this.trains) {
        if (!train.completed) {
          train.completed = true;
          train.status = 'completed';
          train.currentSegmentIndex = Math.max(0, (train.segmentMinutes?.length || 1) - 1);
          train.segmentProgress = 1;
        }
      }
      this.stop();
      return;
    }
    if (this.calendar.dayIndex !== this.currentServiceDayIndex) {
      this.advanceServiceDay(this.calendar);
    }
    for (const train of this.trains) this.updateTrain(train);
    this.tickCounter += 1;
    if (realSeconds > 0 && this.tickCounter % 6 === 0) {
      const requestCount = Math.round(14 * (this.calendar?.demandMultiplier || 1));
      this.sellRealtimeDemand(requestCount);
    }
  }

  advanceServiceDay(calendar) {
    this.currentServiceDayIndex = calendar.dayIndex;
    const newTrains = this.createScheduledServices(this.routes, this.dailyTrainBudget, calendar);
    // SE-2: Retain non-completed trains from previous days instead of
    // discarding them entirely. This preserves bookings on overnight or
    // late-running services across the day boundary. Cap retained count
    // to prevent unbounded memory growth.
    const retained = this.trains.filter((train) => !train.completed).slice(-2000);
    this.trains = [...retained, ...newTrains];
    this.trainById = new Map(this.trains.map((train) => [train.id, train]));
    this.bookingOptions = this.createBookingOptions();
    this.preloadCursor = 0;
    const routeServiceStats = summarizeRouteServices(newTrains, this.routes);
    this.stats.trainCount = newTrains.length;
    this.stats.currentServiceDayIndex = this.currentServiceDayIndex;
    this.stats.currentServiceDayNumber = this.currentServiceDayIndex + 1;
    this.stats.cumulativeTrainServices = (this.stats.cumulativeTrainServices || 0) + newTrains.length;
    Object.assign(this.stats, routeServiceStats);
    this.logEvent('calendar', `${calendar.dateLabel} ${calendar.dayName} service day opened with ${newTrains.length.toLocaleString()} new trains (${retained.length} retained from previous day).`);
    if (this.autoPreloadDemand) this.preloadDemand();
  }

  sellRealtimeDemand(requestCount = 6) {
    let sold = 0;
    // Only consider trains that have not yet departed for live demand bookings.
    const bookable = this.trains.filter((train) => !train.completed && train.departureMinute > this.nowMinutes);
    if (!bookable.length) return sold;
    for (let i = 0; i < requestCount; i += 1) {
      const train = weightedTrainChoice(bookable, this.random('live', this.tickCounter, i));
      const maxOrigin = Math.max(1, train.stops.length - 2);
      const originIndex = Math.min(maxOrigin, Math.floor(this.random(train.id, this.tickCounter, i, 'o') * maxOrigin));
      const maxDest = train.stops.length - 1;
      const tripSpan = 1 + Math.floor(this.random(train.id, this.tickCounter, i, 'd') * Math.min(6, maxDest - originIndex));
      const destinationIndex = Math.min(maxDest, originIndex + tripSpan);
      const seatClass = weightedClass(this.random(train.id, this.tickCounter, i, 'c'));
      const groupSize = groupSizeFromRandom(this.random(train.id, this.tickCounter, i, 'g'));
      const response = this.bookTrip({
        trainId: train.id,
        originIndex,
        destinationIndex,
        seatClass,
        groupSize,
        passengerName: `Live Demand ${this.tickCounter}-${i}`,
        silent: true,
      });
      if (response.ok) sold += groupSize;
    }
    if (sold) this.logEvent('demand', `Live demand sold ${sold} seats across ${requestCount} booking requests.`);
    return sold;
  }

  updateTrain(train) {
    if (train.completed) return;
    if (this.nowMinutes < train.departureMinute) return;
    const previousProgressKey = train.currentSegmentIndex + (train.segmentProgress || 0);
    const wasScheduled = train.status === 'scheduled';
    let elapsed = this.nowMinutes - train.departureMinute;
    let segmentIndex = 0;
    const crossedStationIndexes = [];
    while (segmentIndex < train.segmentMinutes.length && elapsed >= train.segmentMinutes[segmentIndex]) {
      elapsed -= train.segmentMinutes[segmentIndex];
      segmentIndex += 1;
      crossedStationIndexes.push(segmentIndex);
    }
    const nextProgressKey = segmentIndex >= train.segmentMinutes.length
      ? train.segmentMinutes.length
      : segmentIndex + (elapsed / train.segmentMinutes[segmentIndex]);

    // Keep the train state machine monotonic. The UI and worker normally only
    // advance time, but this guard prevents any future replay/speed-control
    // path from making a running train move backward between two stations.
    // Epsilon increased to 1e-4 to tolerate floating-point drift across many
    // segment updates; 1e-6 was freezing trains after prolonged running.
    if (!wasScheduled && nextProgressKey + 1e-4 < previousProgressKey) return;

    train.status = 'running';
    if (wasScheduled) this.processStation(train, 0);
    for (const stationIndex of crossedStationIndexes) {
      if (stationIndex < train.stops.length) this.processStation(train, stationIndex);
    }
    if (segmentIndex >= train.segmentMinutes.length) {
      // Final station processing in case the destination wasn't covered above.
      const finalStop = train.stops.length - 1;
      if (finalStop > 0 && !train.processedStationIndexes.has(finalStop)) {
        this.processStation(train, finalStop);
      }
      if (train.direction === 'outbound' && this.prepareReturnLeg(train)) return;
      this.recordCompletedLeg(train);
      train.completed = true;
      train.status = 'completed';
      train.currentSegmentIndex = train.segmentMinutes.length - 1;
      train.segmentProgress = 1;
      this.logEvent('arrival', `${train.code} completed ${train.origin} to ${train.destination}.`);
      this.bookingOptionsDirty = true;
      return;
    }
    train.currentSegmentIndex = segmentIndex;
    train.segmentProgress = elapsed / train.segmentMinutes[segmentIndex];
  }

  prepareReturnLeg(train) {
    const route = train.baseRoute;
    if (!route || train.direction === 'return') return false;
    if (!train.segmentMinutes?.length) {
      this.logEvent('error', `${train.code} has no segmentMinutes at turnaround; skipping return leg.`);
      return false;
    }
    this.recordCompletedLeg(train);
    const returnStops = reverseStops(route.stops);
    const returnSegments = reverseSegments(route.segments);
    train.direction = 'return';
    train.legIndex = 1;
    train.routeVariantId = train.returnVariantId || `${train.routeId}:return`;
    train.origin = route.destination;
    train.destination = route.origin;
    train.originProvince = route.destinationProvince;
    train.destinationProvince = route.originProvince;
    train.stops = returnStops;
    train.segments = returnSegments;
    train.inventory = new SeatInventory(returnStops);
    train.bookings = [];
    train.departureMinute = this.nowMinutes + train.terminalTurnaroundMinutes;
    train.turnaroundDepartureMinute = train.departureMinute;
    train.segmentMinutes = (train.segmentMinutes || []).slice().reverse();
    train.plannedSegmentMinutes = (train.plannedSegmentMinutes || []).slice().reverse();
    train.status = 'scheduled';
    train.currentSegmentIndex = 0;
    train.segmentProgress = 0;
    train.processedStationIndexes = new Set();
    train.completed = false;
    this.bookingOptionsDirty = true;
    this.logEvent('turnaround', `${train.code} reached ${route.destination}; returning to ${route.origin} at ${formatClock(train.departureMinute)} via the same stops in reverse order.`);
    return true;
  }

  recordCompletedLeg(train) {
    const last = train.completedLegs[train.completedLegs.length - 1];
    if (last?.direction === train.direction) return;
    train.completedLegs.push({
      direction: train.direction,
      routeVariantId: train.routeVariantId,
      origin: train.origin,
      destination: train.destination,
      stopNames: train.stops.map((stop) => stop.name),
      processedStationIndexes: [...train.processedStationIndexes].sort((a, b) => a - b),
    });
  }

  _ensureBookingIndexes(train) {
    if (train._bookingIndexes) return train._bookingIndexes;
    const byOrigin = new Map();
    const byDestination = new Map();
    for (const booking of train.bookings) {
      const o = booking.originIndex;
      const d = booking.destinationIndex;
      if (!byOrigin.has(o)) byOrigin.set(o, []);
      if (!byDestination.has(d)) byDestination.set(d, []);
      byOrigin.get(o).push(booking);
      byDestination.get(d).push(booking);
    }
    train._bookingIndexes = { byOrigin, byDestination };
    return train._bookingIndexes;
  }

  processStation(train, stationIndex) {
    if (train.processedStationIndexes.has(stationIndex)) return;
    train.processedStationIndexes.add(stationIndex);
    const station = train.stops[stationIndex]?.name;
    let boarding = 0;
    let alighting = 0;
    let noShows = 0;
    const indexes = this._ensureBookingIndexes(train);
    for (const booking of (indexes.byOrigin.get(stationIndex) || [])) {
      const seatCount = booking.seats?.length || 1;
      if (booking.status === 'confirmed') {
        // Determine no-show at departure time, not at booking time
        // Allow manual override (e.g. for tests) while keeping deferred evaluation as default.
        const willNoShow = booking.noShow || this.random(booking.ticketId, train.departureMinute, 'noShow') < noShowProbability(train, stationIndex, booking.seatClass);
        if (willNoShow) {
          train.inventory.releaseTicket(booking.ticketId);
          booking.status = 'noShow';
          booking.noShow = true;
          noShows += seatCount;
          this.stats.noShows += seatCount;
        } else {
          booking.status = 'onboard';
          boarding += seatCount;
        }
      }
    }
    for (const booking of (indexes.byDestination.get(stationIndex) || [])) {
      const seatCount = booking.seats?.length || 1;
      if (booking.status === 'onboard') {
        booking.status = 'completed';
        alighting += seatCount;
      }
    }
    this.stats.stationStops += 1;
    this.logEvent('station', `${train.code} stopped at ${station}: ${boarding} boarded, ${alighting} alighted${noShows ? `, ${noShows} no-show release` : ''}.`);
  }

  quoteTrip({ trainId, originIndex, destinationIndex, seatClass = 'secondClass', groupSize = 1 }) {
    return this.computeQuote({ trainId, originIndex, destinationIndex, seatClass, groupSize, exactAvailability: true });
  }

  computeQuote({ trainId, originIndex, destinationIndex, seatClass = 'secondClass', groupSize = 1, exactAvailability = true }) {
    const train = this.getTrain(trainId);
    const started = performance.now();
    train.inventory.validateInterval(originIndex, destinationIndex);
    const canFit = train.inventory.canFitGroup({ originIndex, destinationIndex, seatClass, groupSize });
    const availability = canFit && exactAvailability
      ? train.inventory.availabilityCount({ originIndex, destinationIndex, seatClass })
      : canFit ? groupSize : 0;
    const distanceKm = distanceBetween(train, originIndex, destinationIndex);
    const load = train.inventory.maxLoad(originIndex, destinationIndex, seatClass);
    const departureHour = Math.floor(train.departureMinute / 60) % 24;
    const hoursToDeparture = Math.max(0.2, (train.departureMinute - this.nowMinutes) / 60);
    const serviceCalendar = train.calendar || calendarState(train.departureMinute);
    const forecast = reconcileDemandForecast({
      routeDistanceKm: distanceKm,
      segmentLoad: load.loadFactor,
      dayOfWeek: serviceCalendar.dayOfWeek,
      hour: departureHour,
      stationTier: train.stops[originIndex]?.tier,
      calendarDemand: serviceCalendar.demandMultiplier,
    });
    const velocity = this.bookingVelocity.get(train.routeId) || 0;
    const pricing = priceQuote({
      distanceKm,
      seatClass,
      loadFactor: Math.min(0.99, load.loadFactor * forecast),
      hoursToDeparture,
      departureHour,
      frequencyRank: train.frequencyRank || 0.5,
      noShowRisk: 0.025 + Math.min(0.04, load.loadFactor * 0.04),
      surgeMultiplier: serviceCalendar.priceSurgeMultiplier,
      bookingVelocity: velocity,
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
      calendar: serviceCalendar,
      algorithmMs: Math.round(elapsedMs * 1000) / 1000,
      departureMinute: train.departureMinute,
    };
  }

  bookTrip({ trainId, originIndex, destinationIndex, seatClass = 'secondClass', passengerName = 'Passenger', preference = 'any', accessible = false, groupSize = 1, silent = false }) {
    const quote = this.computeQuote({ trainId, originIndex, destinationIndex, seatClass, groupSize, exactAvailability: !silent });
    const train = this.getTrain(trainId);
    // SE-3 guard: if the service day advanced between quote and book, the train
    // reference is stale. Reject and ask the caller to retry.
    if (train.departureMinute !== quote.departureMinute) {
      this.stats.rejectedBookings += 1;
      return { ok: false, reason: 'Train schedule changed. Please retry your booking.', quote };
    }
    const currentVelocity = this.bookingVelocity.get(train.routeId) || 0;
    this.bookingVelocity.set(train.routeId, currentVelocity + groupSize);
    if (!quote.canBook) {
      this.stats.rejectedBookings += 1;
      return { ok: false, reason: 'No seats available for the requested interval.', quote };
    }
    this.bookingCounter = (this.bookingCounter || 0) + 1;
    const ticketId = generateTicketId(this.seed, this.bookingCounter);
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
      noShow: false,
    };
    train.bookings.push(booking);
    if (train.bookings.length > 1500) {
      train.bookings = train.bookings.slice(-1500);
      train._bookingIndexes = null; // invalidated by cap
    }
    this.bookings.push(booking);
    if (this.bookings.length > 400) this.bookings = this.bookings.slice(-400);
    this.stats.totalRevenue += booking.price;
    this.stats.totalBookings += 1;
    this.stats.totalPassengers += groupSize;
    this.recordLedgerEntry(booking, train);
    if (!silent) this.logEvent('booking', `${booking.trainCode} ${booking.origin} to ${booking.destination}: ${assignedSeats.map((s) => `${s.car}-${s.row}${s.letter}`).join(', ')} for ¥${booking.price}.`);
    return { ok: true, booking, quote };
  }

  recordLedgerEntry(booking, train) {
    if (!this.ledger) this.ledger = [];
    this.ledger.push({
      ticketId: booking.ticketId,
      passengerId: booking.passengerId,
      passengerName: booking.passengerName,
      trainId: booking.trainId,
      trainCode: booking.trainCode,
      routeId: train.routeId,
      origin: booking.origin,
      destination: booking.destination,
      originIndex: booking.originIndex,
      destinationIndex: booking.destinationIndex,
      seatClass: booking.seatClass,
      seats: booking.seats.map((seat) => `${seat.car}-${seat.row}${seat.letter}`),
      price: booking.price,
      distanceKm: booking.distanceKm,
      bookedAtMinute: booking.bookedAtMinute,
      bookedAtClock: formatClock(booking.bookedAtMinute),
      serviceDate: train.calendar?.dateIso,
      status: booking.status,
      noShow: Boolean(booking.noShow),
    });
    // Bound retained ledger size; consumers (worker → server) flush periodically.
    if (this.ledger.length > 4000) this.ledger = this.ledger.slice(-4000);
  }

  /**
   * Drain pending ledger entries for persistence. The browser worker calls this
   * to ship a batch to the static server's `/ingest-bookings` endpoint, which
   * forwards them to OceanBase via `scripts/oceanbase_booking_ingest.py`.
   */
  drainLedger(limit = 1000) {
    if (!this.ledger || !this.ledger.length) return [];
    const drained = this.ledger.slice(0, limit);
    this.ledger = this.ledger.slice(limit);
    return drained;
  }

  cancelBooking(ticketId) {
    let booking = this.bookings.find((item) => item.ticketId === ticketId);
    // If the global bookings array has wrapped, search per-train arrays.
    if (!booking) {
      for (const train of this.trains) {
        booking = train.bookings.find((item) => item.ticketId === ticketId);
        if (booking) break;
      }
    }
    if (!booking) return false;
    const train = this.getTrain(booking.trainId);
    train.inventory.releaseTicket(ticketId);
    train.bookings = train.bookings.filter((item) => item.ticketId !== ticketId);
    train._bookingIndexes = null; // invalidated by removal
    this.bookings = this.bookings.filter((item) => item.ticketId !== ticketId);
    booking.status = 'cancelled';
    this.recordLedgerEntry(booking, train);
    this.logEvent('release', `${booking.trainCode} released ${booking.seats.length} seat(s) after cancellation or alighting logic.`);
    return true;
  }

  getTrain(trainId) {
    const train = this.trainById.get(trainId);
    if (!train) throw new Error(`Unknown train: ${trainId}`);
    return train;
  }

  logEvent(type, message) {
    const id = `${Date.now()}-${(this.eventCounter = (this.eventCounter || 0) + 1)}`;
    this.events.unshift({ id, type, message, minute: Math.round(this.nowMinutes) });
    this.events = this.events.slice(0, 80);
  }

  snapshot({ includeBookingOptions = true } = {}) {
    const nowMinuteFloor = Math.floor(this.nowMinutes);
    if (nowMinuteFloor !== this._lastCalendarMinute) {
      this._lastCalendarMinute = nowMinuteFloor;
      this._cachedCalendar = calendarState(this.nowMinutes);
    }
    const calendar = this._cachedCalendar;

    // Build candidate lists in a single pass to avoid intermediate arrays.
    const active = [];
    const scheduled = [];
    const completed = [];
    for (const train of this.trains) {
      const status = train.status;
      if (status === 'running') {
        active.push({ raw: train, status, stopsLength: train.stops.length, currentSegmentIndex: train.currentSegmentIndex, segmentProgress: train.segmentProgress });
      } else if (status === 'scheduled' && Math.round(train.departureMinute - this.nowMinutes) <= 120) {
        scheduled.push({ raw: train, status, minutesToDeparture: Math.round(train.departureMinute - this.nowMinutes), stopsLength: train.stops.length, currentSegmentIndex: train.currentSegmentIndex, segmentProgress: train.segmentProgress });
      } else if (status === 'completed') {
        completed.push({ raw: train, status, stopsLength: train.stops.length, currentSegmentIndex: train.currentSegmentIndex, segmentProgress: train.segmentProgress });
      }
    }

    const visibleCandidates = selectVisibleCandidates(active, scheduled, completed, SNAPSHOT_TRAIN_LIMIT);
    const visibleTrains = visibleCandidates.map((c) => serializeTrain(c.raw, this.nowMinutes));

    let bookingOptions;
    if (includeBookingOptions || this.bookingOptionsDirty) {
      this.bookingOptions = this.createBookingOptions();
      this.bookingOptionsDirty = false;
      bookingOptions = this.bookingOptions;
    }

    return {
      nowMinutes: Math.round(this.nowMinutes),
      calendar,
      stats: {
        ...this.stats,
        simulationDate: calendar.dateLabel,
        simulationClock: calendar.clock,
        calendarLabel: calendar.label,
        calendarDemandMultiplier: calendar.demandMultiplier,
        calendarCapacityMultiplier: calendar.capacityMultiplier,
        calendarPriceSurgeMultiplier: calendar.priceSurgeMultiplier,
        currentServiceDayNumber: this.stats.currentServiceDayNumber,
        simulationYearDays: this.stats.simulationYearDays,
        cumulativeTrainServices: this.stats.cumulativeTrainServices,
        detailedDayTrainBudget: this.stats.detailedDayTrainBudget,
        fullYearCompleted: this.stats.fullYearCompleted || false,
        activeTrains: active.length,
        scheduledTrains: scheduled.length,
        completedTrains: completed.length,
        visibleTrainCount: visibleTrains.length,
        averageDelayMinutes: (() => {
          let sum = 0;
          for (const train of this.trains) sum += train.delayMinutes || 0;
          return this.trains.length ? Math.round((sum / this.trains.length) * 10) / 10 : 0;
        })(),
        delayedTrains: (() => {
          let count = 0;
          for (const train of this.trains) if ((train.delayMinutes || 0) >= 5) count += 1;
          return count;
        })(),
        activeAverageDelayMinutes: (() => {
          let sum = 0;
          let count = 0;
          for (const train of this.trains) {
            if (train.status === 'running') {
              sum += currentDelay(train);
              count += 1;
            }
          }
          return count ? Math.round((sum / count) * 10) / 10 : 0;
        })(),
        activeDelayedTrains: (() => {
          let count = 0;
          for (const train of this.trains) {
            if (train.status === 'running' && currentDelay(train) >= 3) count += 1;
          }
          return count;
        })(),
      },
      bookings: (() => {
        if (this.bookings !== this._lastBookingsRef) {
          this._lastBookingsRef = this.bookings;
          this._cachedBookings = this.bookings.slice(-12).reverse();
        }
        return this._cachedBookings;
      })(),
      events: (() => {
        if (this.events !== this._lastEventsRef) {
          this._lastEventsRef = this.events;
          this._cachedEvents = this.events.slice();
        }
        return this._cachedEvents;
      })(),
      trains: visibleTrains,
      bookingOptions,
      network: networkSummaryFromTrains(this.trains, this.nowMinutes),
    };
  }

  random(...parts) {
    return seeded(`${this.seed}:${parts.join(':')}`);
  }

  createBookingOptions() {
    if (!this._routeBookingOptions) this._routeBookingOptions = new Map();
    // Exclude completed trains — they are not bookable and their options
    // waste snapshot space. Trains that have already departed but are still
    // running may still be needed for boarding-state display.
    return this.trains
      .filter((train) => !train.completed)
      .map((train) => {
        let base = this._routeBookingOptions.get(train.routeId);
        if (!base) {
          base = {
            routeId: train.routeId,
            code: train.code,
            origin: train.origin,
            destination: train.destination,
            corridor: train.corridor,
            originProvince: train.originProvince,
            destinationProvince: train.destinationProvince,
            // Send only stop names to reduce snapshot size; the frontend only
            // needs names for the booking panel dropdowns.
            stops: train.stops.map((stop, index) => ({ name: stop.name, index })),
            totalDistanceKm: train.totalDistanceKm,
            seatQuota: TRAIN_SEAT_QUOTA,
          };
          this._routeBookingOptions.set(train.routeId, base);
        }
        return {
          ...base,
          id: train.id,
          direction: train.direction,
          routeVariantId: train.routeVariantId,
          departureMinute: train.departureMinute,
          departureClock: formatClock(train.departureMinute),
          serviceDate: train.calendar?.dateLabel,
          servicesForRoute: train.servicesForRoute,
          serviceIndexForRoute: train.serviceIndexForRoute,
        };
      });
  }
}

function allocateDailyServices(routes, maxTrains, calendar) {
  const plans = routes.map((route) => ({
    route,
    desired: serviceCountForRoute(route, calendar),
  }));
  const minTotal = routes.length * MIN_DAILY_TRAINS_PER_ROUTE;
  const desiredTotal = plans.reduce((sum, plan) => sum + plan.desired, 0);
  if (maxTrains === null || maxTrains === undefined || maxTrains === Infinity) {
    return plans.map((plan) => ({ route: plan.route, serviceCount: plan.desired }));
  }
  const effectiveMax = Math.max(minTotal, maxTrains || DEFAULT_DAILY_TRAIN_BUDGET);
  if (desiredTotal <= effectiveMax) {
    return plans.map((plan) => ({ route: plan.route, serviceCount: plan.desired }));
  }

  const extraBudget = effectiveMax - minTotal;
  const desiredExtras = plans.reduce((sum, plan) => sum + Math.max(0, plan.desired - MIN_DAILY_TRAINS_PER_ROUTE), 0);
  if (extraBudget <= 0 || desiredExtras <= 0) {
    return plans.map((plan) => ({ route: plan.route, serviceCount: MIN_DAILY_TRAINS_PER_ROUTE }));
  }

  const scaled = plans.map((plan) => {
    const extra = Math.max(0, plan.desired - MIN_DAILY_TRAINS_PER_ROUTE);
    const rawExtra = extra * extraBudget / desiredExtras;
    return {
      route: plan.route,
      serviceCount: MIN_DAILY_TRAINS_PER_ROUTE + Math.floor(rawExtra),
      remainder: rawExtra - Math.floor(rawExtra),
    };
  });
  let used = scaled.reduce((sum, plan) => sum + plan.serviceCount, 0);
  const byRemainder = scaled.slice().sort((a, b) => b.remainder - a.remainder || (b.route.frequencyRank || 0) - (a.route.frequencyRank || 0));
  for (let i = 0; used < effectiveMax && i < byRemainder.length; i += 1) {
    byRemainder[i].serviceCount += 1;
    used += 1;
  }
  return scaled.map(({ route, serviceCount }) => ({ route, serviceCount }));
}

function serviceCountForRoute(route, calendar) {
  const rank = Math.max(0, Math.min(1, route.frequencyRank || 0.08));
  const stops = route.stops || [];
  const originTier = stops[0]?.tier;
  const destinationTier = stops[stops.length - 1]?.tier;
  const hubScore = tierScore(originTier) + tierScore(destinationTier);
  const distance = route.totalDistanceKm || 0;
  const distanceScore = distance > 1600 ? 2.4 : distance > 900 ? 1.7 : distance > 350 ? 1.1 : 0.55;
  const corridorScore = route.corridor?.includes('East China') || route.corridor?.includes('North China') ? 1.15 : 0.55;
  const serviceNoise = deterministicNoise(`${route.id}:${route.code}:service-plan`) * 2.4;
  const trunkBonus = rank > 0.85 ? 5 : rank > 0.65 ? 3 : rank > 0.35 ? 1 : 0;
  const baseline = MIN_DAILY_TRAINS_PER_ROUTE + Math.round(2.2 + Math.sqrt(rank) * 5.4 + hubScore + distanceScore + corridorScore + serviceNoise + trunkBonus);
  const surgeExtras = Math.round(Math.max(0, baseline - MIN_DAILY_TRAINS_PER_ROUTE) * Math.max(0, (calendar?.capacityMultiplier || 1) - 1) * 0.92);
  const holidayFloor = (calendar?.demandMultiplier || 1) >= 1.35 ? 1 : 0;
  return Math.max(MIN_DAILY_TRAINS_PER_ROUTE, baseline + surgeExtras + holidayFloor);
}

function tierScore(tier) {
  if (tier === 'national-hub') return 1.4;
  if (tier === 'regional-hub') return 0.75;
  return 0.18;
}

function summarizeRouteServices(trains, routes) {
  const counts = new Map(routes.map((route) => [route.id, 0]));
  for (const train of trains) counts.set(train.routeId, (counts.get(train.routeId) || 0) + 1);
  const values = [...counts.values()].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  const percentile = (p) => values.length ? values[Math.floor((values.length - 1) * p)] : 0;
  return {
    trainsPerRoute: routes.length ? Math.round((total / routes.length) * 100) / 100 : 0,
    minTrainsPerRoute: values[0] || 0,
    medianTrainsPerRoute: percentile(0.5),
    maxTrainsPerRoute: values[values.length - 1] || 0,
  };
}

export function calendarState(nowMinutes = 0) {
  const dayIndex = Math.floor(nowMinutes / 1440);
  const minuteOfDay = normalizeDayMinute(Math.floor(nowMinutes));
  const date = new Date(Date.UTC(SERVICE_DAY_START_YEAR, SERVICE_DAY_START_MONTH, SERVICE_DAY_START_DAY + dayIndex));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const dayOfWeek = date.getUTCDay();
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;
  const year = date.getUTCFullYear();
  const holiday = holidayWindow(month, day, year);
  const peakSeason = peakSeasonWindow(month, day, year);
  const labelParts = [];
  let demandMultiplier = 1;
  let capacityMultiplier = 1;
  let priceSurgeMultiplier = 1;

  if (weekend) {
    demandMultiplier *= 1.18;
    capacityMultiplier *= 1.08;
    priceSurgeMultiplier *= 1.06;
    labelParts.push('Weekend');
  }
  if (peakSeason) {
    demandMultiplier *= peakSeason.demand;
    capacityMultiplier *= peakSeason.capacity;
    priceSurgeMultiplier *= peakSeason.price;
    labelParts.push(peakSeason.label);
  }
  if (holiday) {
    demandMultiplier *= holiday.demand;
    capacityMultiplier *= holiday.capacity;
    priceSurgeMultiplier *= holiday.price;
    labelParts.push(holiday.label);
  }

  return {
    dateIso: date.toISOString().slice(0, 10),
    dateLabel: `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${day}`,
    dayName: date.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    dayOfWeek,
    dayIndex,
    minuteOfDay,
    clock: formatClock(minuteOfDay),
    isWeekend: weekend,
    isHoliday: Boolean(holiday),
    label: labelParts.length ? labelParts.join(' + ') : 'Normal weekday',
    demandMultiplier: roundMultiplier(demandMultiplier),
    capacityMultiplier: roundMultiplier(capacityMultiplier),
    priceSurgeMultiplier: roundMultiplier(priceSurgeMultiplier),
  };
}

function holidayWindow(month, day, year = SERVICE_DAY_START_YEAR) {
  const dayOfYear = monthDayToOrdinal(month, day, year);
  const windows = [
    { start: 1, end: 3, label: 'New Year travel surge', demand: 1.58, capacity: 1.34, price: 1.28 },
    { start: 14, end: 53, label: 'Spring Festival Chunyun', demand: 1.95, capacity: 1.52, price: 1.42 },
    { start: 94, end: 96, label: 'Qingming holiday', demand: 1.42, capacity: 1.24, price: 1.2 },
    { start: 121, end: 125, label: 'Labor Day golden week', demand: 1.72, capacity: 1.38, price: 1.34 },
    { start: 170, end: 172, label: 'Dragon Boat holiday', demand: 1.36, capacity: 1.18, price: 1.17 },
    { start: 274, end: 281, label: 'National Day golden week', demand: 1.86, capacity: 1.46, price: 1.38 },
  ];
  return windows.find((window) => dayOfYear >= window.start && dayOfYear <= window.end);
}

function peakSeasonWindow(month, day, year = SERVICE_DAY_START_YEAR) {
  const dayOfYear = monthDayToOrdinal(month, day, year);
  const seasons = [
    { start: 182, end: 243, label: 'Summer student travel peak', demand: 1.28, capacity: 1.16, price: 1.12 },
    { start: 354, end: 365, label: 'Year-end travel peak', demand: 1.2, capacity: 1.1, price: 1.08 },
  ];
  return seasons.find((season) => dayOfYear >= season.start && dayOfYear <= season.end);
}

function monthDayToOrdinal(month, day, year = SERVICE_DAY_START_YEAR) {
  // Leap-year-aware day-of-year via Date arithmetic instead of a hardcoded table.
  const date = new Date(Date.UTC(year, month - 1, day));
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  return Math.floor((date - startOfYear) / 86400000) + 1;
}

function roundMultiplier(value) {
  return Math.round(value * 100) / 100;
}

function plannedSegmentMinutes(route, segment, segmentIndex) {
  const dwell = route.stops[segmentIndex + 1]?.dwellMinutes || 2;
  const speed = Math.min(segment.speedLimitKmh || DEFAULT_SPEED_KMH, DEFAULT_SPEED_KMH);
  return Math.max(8, Math.round((segment.distanceKm / speed) * 60 + dwell));
}

function realisticSegmentMinutes(route, segment, segmentIndex, trainIndex, serviceIndex, calendar) {
  const planned = plannedSegmentMinutes(route, segment, segmentIndex);
  const nextStop = route.stops[segmentIndex + 1];
  const hubPressure = nextStop?.tier === 'national-hub' ? 3 : nextStop?.tier === 'regional-hub' ? 1.5 : 0.4;
  const surgeDispatchPressure = Math.max(0, (calendar?.capacityMultiplier || 1) - 1) * 3.2;
  const weatherDrag = deterministicNoise(`${route.id}:${trainIndex}:${serviceIndex}:${segmentIndex}:weather`) > 0.94 ? 4 : 0;
  const dispatchSlack = deterministicNoise(`${route.id}:${trainIndex}:${serviceIndex}:${segmentIndex}:dispatch`) > 0.86 ? 2 : 0;
  return Math.round(planned + hubPressure + surgeDispatchPressure + weatherDrag + dispatchSlack);
}

function noShowProbability(train, originIndex, seatClass) {
  const station = train.stops[originIndex];
  const base = seatClass === 'business' ? 0.018 : seatClass === 'firstClass' ? 0.026 : 0.038;
  const hubAdjustment = station?.tier === 'national-hub' ? -0.006 : station?.tier === 'local' ? 0.008 : 0;
  const shortHopAdjustment = train.stops.length <= 4 ? 0.006 : 0;
  return Math.max(0.01, Math.min(0.08, base + hubAdjustment + shortHopAdjustment));
}

function scheduledDepartureMinute(route, serviceIndex, serviceCount, globalIndex) {
  const fraction = (serviceIndex + 0.5) / Math.max(1, serviceCount);
  const bucket = departureBucketFor(fraction);
  const bucketProgress = (fraction - bucket.startShare) / bucket.share;
  const baseMinute = bucket.startMinute + bucketProgress * (bucket.endMinute - bucket.startMinute);
  const headwayJitter = Math.min(52, Math.max(6, 420 / Math.max(1, serviceCount)));
  const jitter = (deterministicNoise(`${route.id}:${globalIndex}:${serviceIndex}:departure`) - 0.5) * headwayJitter;
  const trunkBias = route.frequencyRank > 0.75 ? -14 : route.frequencyRank > 0.4 ? -6 : 5;
  return normalizeDayMinute(Math.round(baseMinute + jitter + trunkBias));
}

function departureBucketFor(fraction) {
  const buckets = [
    { startMinute: 0, endMinute: 5 * 60, share: 0.06 },
    { startMinute: 5 * 60, endMinute: 7 * 60, share: 0.1 },
    { startMinute: 7 * 60, endMinute: 10 * 60, share: 0.22 },
    { startMinute: 10 * 60, endMinute: 16 * 60, share: 0.25 },
    { startMinute: 16 * 60, endMinute: 20 * 60, share: 0.25 },
    { startMinute: 20 * 60, endMinute: 24 * 60, share: 0.12 },
  ];
  let startShare = 0;
  for (const bucket of buckets) {
    const endShare = startShare + bucket.share;
    if (fraction <= endShare || bucket === buckets[buckets.length - 1]) {
      return { ...bucket, startShare };
    }
    startShare = endShare;
  }
  return { ...buckets[buckets.length - 1], startShare: 1 - buckets[buckets.length - 1].share };
}

function routeDemandIntensity(train) {
  const rank = train.frequencyRank || 0.08;
  const corridorBoost = train.corridor?.includes('East China') || train.corridor?.includes('North China') ? 0.18 : 0.04;
  const distanceBoost = train.totalDistanceKm > 900 ? 0.08 : train.totalDistanceKm < 300 ? 0.04 : 0.12;
  const hubBoost = (tierScore(train.stops[0]?.tier) + tierScore(train.stops[train.stops.length - 1]?.tier)) / 6;
  return Math.max(0.65, Math.min(1.45, 0.78 + Math.sqrt(rank) * 0.45 + corridorBoost + distanceBoost + hubBoost));
}

function selectVisibleTrains(trains, limit) {
  const active = trains.filter((train) => train.status === 'running');
  const scheduled = trains.filter((train) => train.status === 'scheduled' && train.minutesToDeparture <= 120);
  const completed = trains.filter((train) => train.status === 'completed').slice(-60);
  if (active.length >= limit) {
    return active
      .sort((a, b) => {
        const totalA = (a.stops?.length || 1) - 1;
        const totalB = (b.stops?.length || 1) - 1;
        const progressA = (a.currentSegmentIndex || 0) / Math.max(1, totalA);
        const progressB = (b.currentSegmentIndex || 0) / Math.max(1, totalB);
        return progressB - progressA;
      })
      .slice(0, limit);
  }
  const remaining = limit - active.length;
  const scheduledSlice = scheduled
    .sort((a, b) => a.minutesToDeparture - b.minutesToDeparture)
    .slice(0, Math.min(remaining, scheduled.length));
  const completedSlice = completed.slice(-Math.min(Math.max(0, remaining - scheduledSlice.length), 60));
  return [...active, ...scheduledSlice, ...completedSlice];
}

function selectVisibleCandidates(active, scheduled, completed, limit) {
  if (active.length >= limit) {
    return active
      .sort((a, b) => {
        const totalA = (a.stopsLength || 1) - 1;
        const totalB = (b.stopsLength || 1) - 1;
        const progressA = (a.currentSegmentIndex || 0) / Math.max(1, totalA);
        const progressB = (b.currentSegmentIndex || 0) / Math.max(1, totalB);
        return progressB - progressA;
      })
      .slice(0, limit);
  }
  const remaining = limit - active.length;
  const scheduledSlice = scheduled
    .sort((a, b) => a.minutesToDeparture - b.minutesToDeparture)
    .slice(0, Math.min(remaining, scheduled.length));
  const completedSlice = completed.slice(-Math.min(Math.max(0, remaining - scheduledSlice.length), 60));
  return [...active, ...scheduledSlice, ...completedSlice];
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

function networkSummaryFromTrains(trains, nowMinutes) {
  const byCorridor = new Map();
  const byProvince = new Map();
  const byStation = new Map();
  for (const train of trains) {
    incrementRaw(byCorridor, train.corridor || 'Unknown', train);
    incrementRaw(byProvince, train.originProvince || 'Unknown', train);
    if (train.status === 'running') {
      const safeSegmentIndex = Math.min(Math.max(0, train.currentSegmentIndex || 0), Math.max(0, (train.segments?.length || 1) - 1));
      const displaySegmentIndex = train.status === 'completed' ? Math.max(0, (train.stops?.length || 1) - 2) : safeSegmentIndex;
      const from = train.stops[displaySegmentIndex] || train.stops[0];
      incrementRaw(byStation, from.name || 'Unknown', train);
    }
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

function incrementRaw(map, key, train) {
  if (!map.has(key)) map.set(key, { trains: 0, active: 0, passengers: 0 });
  const value = map.get(key);
  value.trains += 1;
  if (train.status === 'running') value.active += 1;
  const segmentIndex = Math.min(Math.max(0, train.currentSegmentIndex || 0), Math.max(0, (train.segments?.length || 1) - 1));
  value.passengers += train.inventory.occupancyForSegment(segmentIndex).occupied || 0;
}

function serializeTrain(train, nowMinutes) {
  const safeSegmentIndex = Math.min(Math.max(0, train.currentSegmentIndex || 0), Math.max(0, (train.segments?.length || 1) - 1));
  const displaySegmentIndex = train.status === 'completed' ? Math.max(0, (train.stops?.length || 1) - 2) : safeSegmentIndex;
  const segmentProgress = train.status === 'completed' ? 1 : (train.segmentProgress || 0);
  const from = train.stops[displaySegmentIndex] || train.stops[0];
  const to = train.stops[displaySegmentIndex + 1] || from;
  const segment = train.segments[displaySegmentIndex];
  const coords = interpolateLine(segment?.geometry, segmentProgress) || interpolateCoord(from, to, segmentProgress);
  const activeLoad = train.inventory.occupancyForSegment(safeSegmentIndex);
  return {
    id: train.id,
    code: train.code,
    routeId: train.routeId,
    routeVariantId: train.routeVariantId,
    direction: train.direction,
    origin: train.origin,
    destination: train.destination,
    corridor: train.corridor,
    currentStation: train.status === 'completed' ? to.name : from.name,
    nextStation: to.name,
    coords,
    status: train.status,
    currentSegmentIndex: displaySegmentIndex,
    routeProgress: Math.round(((displaySegmentIndex + segmentProgress) / Math.max(1, train.segmentMinutes.length)) * 1000000) / 1000000,
    loadFactor: activeLoad.loadFactor,
    passengerCount: activeLoad.occupied,
    capacity: activeLoad.capacity,
    stops: train.stops.map((stop, index) => ({ name: stop.name, index })),
    totalDistanceKm: train.totalDistanceKm,
  };
}

function reverseStops(stops = []) {
  return stops.slice().reverse().map((stop) => ({ ...stop }));
}

function reverseSegments(segments = []) {
  return segments.slice().reverse().map((segment) => ({
    ...segment,
    from: segment.to,
    to: segment.from,
    geometry: (segment.geometry || []).slice().reverse().map((coord) => Array.isArray(coord) ? coord.slice() : coord),
  }));
}

function stopSequenceHash(stops = []) {
  let hash = 2166136261;
  for (const stop of stops) {
    const key = `${stop.id || ''}:${stop.name || ''}>`;
    for (const char of key) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function average(values) {
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function distanceBetween(train, originIndex, destinationIndex) {
  let total = 0;
  for (let index = originIndex; index < destinationIndex; index += 1) {
    // Use ?? so distanceKm = 0 is preserved; only null/undefined falls back to haversine.
    total += train.segments[index]?.distanceKm ?? haversineKm(train.stops[index], train.stops[index + 1]);
  }
  return total;
}

function currentDelay(train) {
  if (train.status === 'scheduled') return 0;
  if (train.status === 'completed') return train.delayMinutes || 0;
  let planned = 0;
  let actual = 0;
  for (let i = 0; i < train.currentSegmentIndex; i += 1) {
    planned += train.plannedSegmentMinutes[i] || 0;
    actual += train.segmentMinutes[i] || 0;
  }
  planned += (train.plannedSegmentMinutes[train.currentSegmentIndex] || 0) * (train.segmentProgress || 0);
  actual += (train.segmentMinutes[train.currentSegmentIndex] || 0) * (train.segmentProgress || 0);
  return Math.max(0, Math.round((actual - planned) * 10) / 10);
}

function weightedClass(value) {
  if (value < 0.035) return 'business';
  if (value < 0.2) return 'firstClass';
  return 'secondClass';
}

function groupSizeFromRandom(value) {
  if (value < 0.12) return 1;
  if (value < 0.25) return 2;
  if (value < 0.42) return 3;
  if (value < 0.63) return 4;
  if (value < 0.84) return 5;
  return 6;
}

function weightedTrainChoice(trains, value) {
  const weights = trains.map((train) => {
    // For scheduled trains, use average load across all segments instead of
    // segment 0 only, which can be misleading when bookings are distributed.
    const load = train.status === 'scheduled'
      ? train.inventory.averageLoadFactor()
      : train.inventory.occupancyForSegment(train.currentSegmentIndex || 0).loadFactor;
    const departurePressure = train.departureMinute > 0 ? Math.max(0.2, Math.min(1.5, 1.1 - Math.abs(train.departureMinute - 540) / 900)) : 1;
    return Math.max(0.1, (train.frequencyRank || 0.3) + 0.2) * departurePressure * Math.max(0.15, 1 - load);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = value * total;
  for (let i = 0; i < trains.length; i += 1) {
    target -= weights[i];
    if (target <= 0) return trains[i];
  }
  return trains[trains.length - 1];
}

function generateTicketId(seed, counter) {
  // Deterministic-but-unique ticket IDs: combine seed + monotonic counter +
  // a small shuffle so consecutive IDs don't look sequential to readers.
  const base = (counter * 2654435761) ^ (seed >>> 0);
  const hex = (base >>> 0).toString(36).toUpperCase().padStart(7, '0');
  const tail = (counter % 9999).toString().padStart(4, '0');
  return `T${hex}${tail}`;
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

function normalizeDayMinute(minute) {
  return ((minute % 1440) + 1440) % 1440;
}

function formatClock(minutes) {
  const normalized = normalizeDayMinute(Math.round(minutes));
  const hour = Math.floor(normalized / 60).toString().padStart(2, '0');
  const minute = (normalized % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}
