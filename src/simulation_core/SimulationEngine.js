import { SeatInventory, CLASS_ORDER } from '../algorithms/seatInventory.js';
import { priceQuote, reconcileDemandForecast } from '../algorithms/pricing.js';
import { haversineKm, interpolateCoord, interpolateLine } from './geo.js';

const DEFAULT_SPEED_KMH = 285;
const DEFAULT_MAX_TRAINS = 6000;
const MIN_DAILY_TRAINS_PER_ROUTE = 2;
const SNAPSHOT_TRAIN_LIMIT = 1200;
const TRAIN_SEAT_QUOTA = 554;
const SERVICE_DAY_START_YEAR = 2026;
const SERVICE_DAY_START_MONTH = 0;
const SERVICE_DAY_START_DAY = 1;

export class SimulationEngine {
  constructor({ stations = [], routes = [], seed = 20260502, maxTrains = DEFAULT_MAX_TRAINS, preloadDemand = true } = {}) {
    this.seed = seed;
    this.stations = stations;
    this.routes = routes;
    this.nowMinutes = 8 * 60 + 20;
    this.calendar = calendarState(this.nowMinutes);
    this.trains = this.createScheduledServices(routes, maxTrains);
    this.trainById = new Map(this.trains.map((train) => [train.id, train]));
    this.bookingOptions = this.createBookingOptions();
    this.bookings = [];
    this.events = [];
    this.running = false;
    this.speed = 10;
    this.callbacks = { onUpdate: null };
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
      ...routeServiceStats,
    };
    this.tickCounter = 0;
    if (preloadDemand) this.preloadDemand();
    this.tick(0);
  }

  createScheduledServices(routes, maxTrains) {
    if (!routes.length) return [];
    const trains = [];
    const plans = allocateDailyServices(routes, maxTrains, this.calendar);
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
    const departureMinute = scheduledDepartureMinute(route, serviceIndex, serviceCount, index);
    const plannedRuntimes = route.segments.map((segment, segmentIndex) => plannedSegmentMinutes(route, segment, segmentIndex));
    const segmentMinutes = route.segments.map((segment, segmentIndex) => realisticSegmentMinutes(route, segment, segmentIndex, index, serviceIndex, calendar));
    const serviceSuffix = serviceIndex > 0 ? `-${serviceIndex + 1}` : '';
    const delayMinutes = Math.max(0, Math.round(segmentMinutes.reduce((sum, minutes) => sum + minutes, 0) - plannedRuntimes.reduce((sum, minutes) => sum + minutes, 0)));
    return {
      id: `${route.id}${serviceSuffix}`,
      routeId: route.id,
      code: serviceIndex > 0 ? `${route.code}.${serviceIndex + 1}` : route.code,
      type: route.type,
      origin: route.origin,
      destination: route.destination,
      originProvince: route.originProvince,
      destinationProvince: route.destinationProvince,
      corridor: route.corridor,
      calendar,
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
      completed: false,
      bookings: [],
      algorithmMetrics: [],
    };
  }

  preloadDemand() {
    for (const train of this.trains) {
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
    this.calendar = calendarState(this.nowMinutes);
    for (const train of this.trains) this.updateTrain(train);
    this.tickCounter += 1;
    if (realSeconds > 0 && this.tickCounter % 6 === 0) {
      const requestCount = Math.round(14 * (this.calendar?.demandMultiplier || 1));
      this.sellRealtimeDemand(requestCount);
    }
  }

  sellRealtimeDemand(requestCount = 6) {
    let sold = 0;
    const bookable = this.trains.filter((train) => !train.completed && train.departureMinute > this.nowMinutes - 20);
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
    const pricing = priceQuote({
      distanceKm,
      seatClass,
      loadFactor: Math.min(0.99, load.loadFactor * forecast),
      hoursToDeparture,
      departureHour,
      frequencyRank: train.frequencyRank || 0.5,
      noShowRisk: 0.025 + Math.min(0.04, load.loadFactor * 0.04),
      surgeMultiplier: serviceCalendar.priceSurgeMultiplier,
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
    };
  }

  bookTrip({ trainId, originIndex, destinationIndex, seatClass = 'secondClass', passengerName = 'Passenger', preference = 'any', accessible = false, groupSize = 1, silent = false }) {
    const quote = this.computeQuote({ trainId, originIndex, destinationIndex, seatClass, groupSize, exactAvailability: !silent });
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

  snapshot({ includeBookingOptions = true } = {}) {
    const calendar = calendarState(this.nowMinutes);
    const serialized = this.trains.map((train) => serializeTrain(train, this.nowMinutes));
    const visibleTrains = selectVisibleTrains(serialized, SNAPSHOT_TRAIN_LIMIT);
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
        activeTrains: serialized.filter((train) => train.status === 'running').length,
        scheduledTrains: serialized.filter((train) => train.status === 'scheduled').length,
        completedTrains: serialized.filter((train) => train.status === 'completed').length,
        visibleTrainCount: visibleTrains.length,
        averageDelayMinutes: average(serialized.map((train) => train.delayMinutes || 0)),
        delayedTrains: serialized.filter((train) => (train.delayMinutes || 0) >= 5).length,
        activeAverageDelayMinutes: average(serialized.filter((train) => train.status === 'running').map((train) => train.currentDelayMinutes || 0)),
        activeDelayedTrains: serialized.filter((train) => train.status === 'running' && (train.currentDelayMinutes || 0) >= 3).length,
      },
      bookings: this.bookings.slice(-12).reverse(),
      events: this.events,
      trains: visibleTrains,
      bookingOptions: includeBookingOptions ? this.bookingOptions : undefined,
      network: networkSummary(serialized),
    };
  }

  random(...parts) {
    return seeded(`${this.seed}:${parts.join(':')}`);
  }

  createBookingOptions() {
    return this.trains.map((train) => ({
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
      departureClock: formatClock(train.departureMinute),
      serviceDate: train.calendar?.dateLabel,
      servicesForRoute: train.servicesForRoute,
      serviceIndexForRoute: train.serviceIndexForRoute,
      totalDistanceKm: train.totalDistanceKm,
      seatQuota: TRAIN_SEAT_QUOTA,
    }));
  }
}

function allocateDailyServices(routes, maxTrains, calendar) {
  const plans = routes.map((route) => ({
    route,
    desired: serviceCountForRoute(route, calendar),
  }));
  const minTotal = routes.length * MIN_DAILY_TRAINS_PER_ROUTE;
  const effectiveMax = Math.max(minTotal, maxTrains || DEFAULT_MAX_TRAINS);
  const desiredTotal = plans.reduce((sum, plan) => sum + plan.desired, 0);
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
  const holiday = holidayWindow(month, day);
  const peakSeason = peakSeasonWindow(month, day);
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

function holidayWindow(month, day) {
  const dayOfYear = monthDayToOrdinal(month, day);
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

function peakSeasonWindow(month, day) {
  const dayOfYear = monthDayToOrdinal(month, day);
  const seasons = [
    { start: 182, end: 243, label: 'Summer student travel peak', demand: 1.28, capacity: 1.16, price: 1.12 },
    { start: 354, end: 365, label: 'Year-end travel peak', demand: 1.2, capacity: 1.1, price: 1.08 },
  ];
  return seasons.find((season) => dayOfYear >= season.start && dayOfYear <= season.end);
}

function monthDayToOrdinal(month, day) {
  const monthStarts = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return monthStarts[month] + day;
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
  const segment = train.segments[train.currentSegmentIndex];
  const coords = interpolateLine(segment?.geometry, train.segmentProgress || 0) || interpolateCoord(from, to, train.segmentProgress || 0);
  const activeLoad = train.inventory.occupancyForSegment(train.currentSegmentIndex);
  const classLoads = Object.fromEntries(CLASS_ORDER.map((seatClass) => [seatClass, train.inventory.occupancyForSegment(train.currentSegmentIndex, seatClass)]));
  const currentDelayMinutes = currentDelay(train);
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
    currentDelayMinutes,
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
    const load = train.inventory.occupancyForSegment(train.currentSegmentIndex || 0).loadFactor;
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

function normalizeDayMinute(minute) {
  return ((minute % 1440) + 1440) % 1440;
}

function formatClock(minutes) {
  const normalized = normalizeDayMinute(Math.round(minutes));
  const hour = Math.floor(normalized / 60).toString().padStart(2, '0');
  const minute = (normalized % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}
