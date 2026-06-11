import { SeatInventory } from '../algorithms/seatInventory.js';
import { priceQuote, reconcileDemandForecast } from '../algorithms/pricing.js';
import { haversineKm, interpolateCoord, interpolateLine } from './geo.js';

const DEFAULT_SPEED_KMH = 285;
const DEFAULT_DAILY_TRAIN_BUDGET = 6000;
export const MIN_DAILY_TRAINS_PER_ROUTE = 6;
const MAX_DAILY_TRAINS_PER_ROUTE = 36;
const SNAPSHOT_TRAIN_LIMIT = 800;
const TRAIN_SEAT_QUOTA = 554;
const SERVICE_YEAR_DAYS = 365;
const TERMINAL_TURNAROUND_MINUTES = 18;
const SERVICE_DAY_START_YEAR = 2026;
const SERVICE_DAY_START_MONTH = 0;
const SERVICE_DAY_START_DAY = 1;

const STATION_CAPACITIES = {
  '北京南': { platforms: 24, maxTrainsPerHour: 120 },
  '上海虹桥': { platforms: 30, maxTrainsPerHour: 140 },
  '广州南': { platforms: 28, maxTrainsPerHour: 130 },
  '深圳北': { platforms: 20, maxTrainsPerHour: 100 },
  '南京南': { platforms: 22, maxTrainsPerHour: 110 },
  '杭州东': { platforms: 20, maxTrainsPerHour: 100 },
  '武汉': { platforms: 18, maxTrainsPerHour: 90 },
  '郑州东': { platforms: 20, maxTrainsPerHour: 100 },
  '西安北': { platforms: 22, maxTrainsPerHour: 110 },
  '成都东': { platforms: 18, maxTrainsPerHour: 90 },
  '重庆北': { platforms: 16, maxTrainsPerHour: 80 },
};

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
    this.delayGraph = buildDelayGraph(routes);
    this.platformOccupancy = new Map();
    this.activeScenarios = [];
    this.scenarioCounter = 0;
    this.autoDisturbances = true;
    this._lastDisturbanceRollMinute = null;
    this.eventsVersion = 0;
    this.bookingsVersion = 0;
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
    // MINIMUM LOAD GUARANTEE: every train gets at least a 22% base target load
    // so low-rank routes don't run completely empty.
    const baseLoad = 0.58 + demandIntensity * 0.16 + (calendarDemand - 1) * 0.14;
    const targetLoad = Math.min(0.96, Math.max(0.22, baseLoad + this.random(train.id, 'load') * 0.12));
    const targetPassengers = Math.round(TRAIN_SEAT_QUOTA * targetLoad);
    // Ensure enough attempts even for low-demand trains (min 55 attempts)
    const attempts = Math.max(55, Math.round(targetPassengers / 3.8));
    let bookedPassengers = 0;
    for (let i = 0; i < attempts && bookedPassengers < targetPassengers; i += 1) {
      // Wider trip span for longer routes to fill more seats
      const maxSpan = Math.min(8, train.stops.length - 1);
      const originIndex = Math.floor(this.random(train.id, i) * Math.max(1, train.stops.length - 2));
      const maxDest = train.stops.length - 1;
      const destinationIndex = Math.min(maxDest, originIndex + 1 + Math.floor(this.random(train.id, i, 'd') * Math.min(maxSpan, maxDest - originIndex)));
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
    this.speed = Math.max(1, Math.min(480, speed));
  }

  loop() {
    if (!this.running) return;
    const frameStartMs = performance.now();
    const elapsedSec = this.lastTickMs ? Math.min(0.5, (frameStartMs - this.lastTickMs) / 1000) : 0.1;
    this.lastTickMs = frameStartMs;
    this.tick(elapsedSec);
    if (this.callbacks.onUpdate) this.callbacks.onUpdate(this.snapshot());
    // Schedule the next frame to maintain ~20 Hz without piling up
    // callbacks when tick() + snapshot() exceed 50 ms.
    const processingMs = performance.now() - frameStartMs;
    const intervalMs = Math.max(1, Math.round(1000 / 20 - processingMs));
    this.timer = setTimeout(() => this.loop(), intervalMs);
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
    // calendarState builds Date objects and locale strings; at 20 Hz that is
    // wasted work because the result only changes once per simulated minute.
    if (currentMinute !== this._calendarCacheMinute) {
      this._calendarCacheMinute = currentMinute;
      this.calendar = calendarState(this.nowMinutes);
    }
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
    if (this.activeScenarios.length) {
      // Demand scenarios lift the cached calendar multipliers (idempotent max).
      for (const scenario of this.activeScenarios) {
        if (scenario.type === 'demand' && this.nowMinutes < scenario.untilMinute) {
          this.calendar.demandMultiplier = Math.max(this.calendar.demandMultiplier, scenario.demandMultiplier);
          this.calendar.priceSurgeMultiplier = Math.max(this.calendar.priceSurgeMultiplier, scenario.priceSurgeMultiplier);
        }
      }
      // Disruption scenarios slow each affected train exactly once; checking
      // once per simulated minute (instead of 20x per real second) keeps this
      // off the hot path and stops delays compounding without bound.
      if (currentMinute !== previousMinute) this.applyDisruptionScenarios();
      if (this.activeScenarios.some((scenario) => this.nowMinutes >= scenario.untilMinute)) {
        for (const scenario of this.activeScenarios) {
          if (this.nowMinutes >= scenario.untilMinute) {
            this.logEvent('scenario', `${scenario.label} cleared after affecting ${scenario.appliedTrainIds?.size || 0} trains.`);
          }
        }
        this.activeScenarios = this.activeScenarios.filter((scenario) => this.nowMinutes < scenario.untilMinute);
      }
    }
    if (this.autoDisturbances && currentMinute !== previousMinute) {
      this.maybeInjectAutoDisturbance(currentMinute);
    }
    for (const train of this.trains) {
      if (train.completed) continue;
      this.updateTrain(train);
    }
    this.tickCounter += 1;
    if (realSeconds > 0 && this.tickCounter % 6 === 0) {
      const hourShape = hourlyDemandShape(this.calendar.minuteOfDay);
      const requestCount = Math.round(14 * (this.calendar?.demandMultiplier || 1) * hourShape);
      if (requestCount > 0) this.sellRealtimeDemand(requestCount);
      this.maybeCancelBooking();
    }
  }

  /**
   * Live cancellation churn: a small share of confirmed bookings is returned
   * before departure, releasing the held seat intervals for resale and
   * writing a `cancelled` row to the OceanBase booking ledger.
   */
  maybeCancelBooking() {
    if (!this.bookings.length) return;
    if (this.random('cancel', this.tickCounter) > 0.08) return;
    const index = Math.floor(this.random('cancel', this.tickCounter, 'idx') * this.bookings.length);
    const booking = this.bookings[index];
    if (!booking || booking.status !== 'confirmed') return;
    const train = this.trainById.get(booking.trainId);
    if (!train || train.completed || train.departureMinute <= this.nowMinutes) return;
    this.cancelBooking(booking.ticketId);
  }

  /**
   * Apply weather/infrastructure disruptions as a one-time slowdown per
   * affected running train: remaining segments are stretched proportionally
   * so the train visibly slows for the rest of its run, and the lost time is
   * recorded in delayMinutes for cascade propagation and dashboards.
   */
  applyDisruptionScenarios() {
    for (const scenario of this.activeScenarios) {
      if (scenario.type === 'demand') continue;
      if (this.nowMinutes >= scenario.untilMinute) continue;
      for (const train of this.trains) {
        if (train.status !== 'running' || train.completed) continue;
        if (scenario.appliedTrainIds.has(train.id)) continue;
        if (!scenarioAffectsTrain(scenario, train)) continue;
        scenario.appliedTrainIds.add(train.id);
        const severity = 0.6 + this.random(scenario.id, train.id, 'impact') * 0.8;
        const stretch = scenario.delayMinutes * severity;
        const firstUntouched = train.currentSegmentIndex + 1;
        const remainingSegments = train.segmentMinutes.length - firstUntouched;
        if (remainingSegments > 0) {
          const perSegment = stretch / remainingSegments;
          for (let i = firstUntouched; i < train.segmentMinutes.length; i += 1) {
            train.segmentMinutes[i] += perSegment;
          }
        }
        train.delayMinutes = (train.delayMinutes || 0) + stretch;
      }
    }
  }

  /**
   * Seasonal stochastic disturbances make the network dynamic without user
   * input: summer thunderstorms/typhoons, winter snow on northern corridors,
   * and year-round equipment failures. Rolls are deterministic per 30-minute
   * simulated slot so a given seed replays the same operational year.
   */
  maybeInjectAutoDisturbance(currentMinute) {
    const slot = Math.floor(currentMinute / 30);
    if (slot === this._lastDisturbanceRollMinute) return;
    this._lastDisturbanceRollMinute = slot;
    if (this.activeScenarios.length >= 3) return;
    const month = Number((this.calendar.dateIso || '2026-01-01').slice(5, 7));
    const hour = Math.floor((this.calendar.minuteOfDay || 0) / 60);
    const roll = this.random('disturbance', slot);
    const pick = this.random('disturbance', slot, 'which');

    if (month >= 6 && month <= 8 && hour >= 12 && hour <= 20 && roll < 0.1) {
      this.injectScenario('thunderstorm', { durationHours: 2 + Math.round(pick * 2), delayMinutes: 12 + Math.round(pick * 14), auto: true });
      return;
    }
    if (month >= 7 && month <= 9 && roll < 0.02) {
      this.injectScenario('typhoon', { durationHours: 6 + Math.round(pick * 6), delayMinutes: 30 + Math.round(pick * 30), auto: true });
      return;
    }
    if ((month === 12 || month <= 2) && roll < 0.06) {
      this.injectScenario('snow', { durationHours: 3 + Math.round(pick * 5), delayMinutes: 15 + Math.round(pick * 20), auto: true });
      return;
    }
    if (roll < 0.025) {
      this.injectScenario('equipment_failure', { durationHours: 1 + Math.round(pick * 2), delayMinutes: 10 + Math.round(pick * 20), auto: true });
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
    this.platformOccupancy.clear();
    // Background preload will start automatically via ensureBackgroundPreload
    // in the worker. Synchronous preload here would freeze the UI for ~7s.
  }

  sellRealtimeDemand(requestCount = 6) {
    let sold = 0;
    // Only consider trains that have not yet departed for live demand bookings.
    const bookable = this.trains.filter((train) => !train.completed && train.departureMinute > this.nowMinutes);
    if (!bookable.length) return sold;
    // Weight every candidate once per sales cycle (not once per request) and
    // sample via prefix sums + binary search: O(n + k log n) instead of O(nk).
    const prefix = new Float64Array(bookable.length);
    let totalWeight = 0;
    for (let i = 0; i < bookable.length; i += 1) {
      totalWeight += trainDemandWeight(bookable[i]);
      prefix[i] = totalWeight;
    }
    for (let i = 0; i < requestCount; i += 1) {
      // 15% chance of "exploration" — pick a random train to ensure
      // low-frequency routes still get some live demand instead of
      // being starved by the weighted choice algorithm.
      let train;
      const explorationRoll = this.random('live', this.tickCounter, i, 'explore');
      if (explorationRoll < 0.15 && bookable.length > 1) {
        const randomIndex = Math.floor(this.random('live', this.tickCounter, i, 'rand') * bookable.length);
        train = bookable[randomIndex];
      } else {
        const target = this.random('live', this.tickCounter, i) * totalWeight;
        train = bookable[prefixLowerBound(prefix, target)];
      }
      const maxOrigin = Math.max(1, train.stops.length - 2);
      const originIndex = Math.min(maxOrigin, Math.floor(this.random(train.id, this.tickCounter, i, 'o') * maxOrigin));
      const maxDest = train.stops.length - 1;
      const maxSpan = Math.min(8, maxDest - originIndex);
      const tripSpan = 1 + Math.floor(this.random(train.id, this.tickCounter, i, 'd') * maxSpan);
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
    // Cascade a delay only when it has materially grown since the last
    // propagation. The previous per-tick propagation re-scanned every train
    // 20 times a second and silently saturated downstream delays at the cap.
    if (train.delayMinutes > 5 && train.delayMinutes - (train._lastPropagatedDelay || 0) >= 3) {
      train._lastPropagatedDelay = train.delayMinutes;
      this.propagateDelay(train, train.delayMinutes);
    }
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
    train._serializedStops = null;
    train.segments = returnSegments;
    train.inventory = new SeatInventory(returnStops);
    train.bookings = [];
    train._bookingIndexes = null; // outbound index is invalid for the return leg
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
    const capacity = STATION_CAPACITIES[station];
    if (capacity) {
      const hourSlot = Math.floor(this.nowMinutes / 60);
      const slotKey = `${station}@${hourSlot}`;
      const current = this.platformOccupancy.get(slotKey) || 0;
      if (current >= capacity.maxTrainsPerHour) {
        const platformDelay = 3 + Math.floor(this.random(train.id, 'platform') * 5);
        train.delayMinutes = (train.delayMinutes || 0) + platformDelay;
        this.logEvent('delay', `${train.code} delayed ${platformDelay} min at ${station} due to platform congestion.`);
      } else {
        this.platformOccupancy.set(slotKey, current + 1);
      }
    }
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
    const realBaseFare = resolveRealBaseFare(train, seatClass);
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
      baseFare: realBaseFare,
    });
    const delayPrediction = this.predictDelayLikelihood(train);
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
      delayPrediction,
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
    } else if (train._bookingIndexes) {
      // Keep the station-processing index in sync so bookings made after the
      // index was first built still board/alight/no-show at their stations.
      const { byOrigin, byDestination } = train._bookingIndexes;
      if (!byOrigin.has(originIndex)) byOrigin.set(originIndex, []);
      byOrigin.get(originIndex).push(booking);
      if (!byDestination.has(destinationIndex)) byDestination.set(destinationIndex, []);
      byDestination.get(destinationIndex).push(booking);
    }
    this.bookings.push(booking);
    if (this.bookings.length > 400) this.bookings = this.bookings.slice(-400);
    this.bookingsVersion += 1;
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
    this.bookingsVersion += 1;
    this.stats.cancelledBookings = (this.stats.cancelledBookings || 0) + 1;
    // 12306 refunds retain a handling fee (5-20% by notice period); model 10%.
    this.stats.totalRevenue = Math.max(0, this.stats.totalRevenue - booking.price * 0.9);
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
    // Truncate in place (amortized) instead of cloning an 80-element array on
    // every event — station stops alone produce ~85k events per simulated day.
    if (this.events.length > 120) this.events.length = 80;
    this.eventsVersion += 1;
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

    // Cache network summary: only recompute every 5 snapshots since it changes slowly
    if (!this._networkCacheTick || this.tickCounter - this._networkCacheTick >= 5) {
      this._networkCache = networkSummaryFromTrains(this.trains, this.nowMinutes);
      this._networkCacheTick = this.tickCounter;
    }

    // Compute active delay stats only from the already-filtered active list
    let activeDelaySum = 0;
    let activeDelayedCount = 0;
    for (const candidate of active) {
      const d = currentDelay(candidate.raw);
      activeDelaySum += d;
      if (d >= 3) activeDelayedCount += 1;
    }

    // Version counters instead of reference identity: pushes mutate the
    // arrays in place, so reference checks missed most updates.
    if (this.bookingsVersion !== this._lastBookingsVersion) {
      this._lastBookingsVersion = this.bookingsVersion;
      this._cachedBookings = this.bookings.slice(-12).reverse();
    }
    if (this.eventsVersion !== this._lastEventsVersion) {
      this._lastEventsVersion = this.eventsVersion;
      this._cachedEvents = this.events.slice();
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
        activeAverageDelayMinutes: active.length ? Math.round((activeDelaySum / active.length) * 10) / 10 : 0,
        activeDelayedTrains: activeDelayedCount,
        activeScenarios: this.activeScenarios.map(s => ({
          type: s.type,
          label: s.label,
          remainingMinutes: Math.max(0, Math.round(s.untilMinute - this.nowMinutes)),
        })),
      },
      bookings: this._cachedBookings,
      events: this._cachedEvents,
      trains: visibleTrains,
      bookingOptions,
      network: this._networkCache,
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
            stops: train._serializedStops || (train._serializedStops = train.stops.map((stop, index) => ({ name: stop.name, index }))),
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

  propagateDelay(sourceTrain, delayMinutes) {
    const fraction = Math.min(0.5, delayMinutes / 60);
    const sourceDeparture = sourceTrain.departureMinute;
    const connectedRoutes = this.delayGraph.get(sourceTrain.routeId) || [];
    for (const train of this.trains) {
      if (train.id === sourceTrain.id) continue;
      if (train.status !== 'scheduled') continue;
      const departsWithinWindow = train.departureMinute > sourceDeparture && train.departureMinute <= sourceDeparture + 120;
      if (!departsWithinWindow) continue;
      const sameRoute = train.routeId === sourceTrain.routeId;
      const connectedRoute = connectedRoutes.some((c) => c.routeId === train.routeId);
      const sharesDestination = train.destination === sourceTrain.destination;
      if (sameRoute || connectedRoute || sharesDestination) {
        const headroom = 45 - (train.delayMinutes || 0);
        if (headroom <= 0) continue;
        const addedDelay = Math.min(headroom, Math.max(1, Math.round(fraction * delayMinutes)));
        train.delayMinutes = (train.delayMinutes || 0) + addedDelay;
        // A knock-on delay holds the connecting service at the platform —
        // push the actual departure back, not just the reporting metric.
        train.departureMinute += addedDelay;
      }
    }
  }

  injectScenario(type, params = {}) {
    const catalog = {
      thunderstorm: { kind: 'weather', label: 'Thunderstorm', delayMinutes: 20, durationHours: 3, corridorFilter: null },
      typhoon: { kind: 'weather', label: 'Typhoon landfall', delayMinutes: 45, durationHours: 8, corridorFilter: /South|East China|Southeast/i },
      snow: { kind: 'weather', label: 'Snow and ice', delayMinutes: 25, durationHours: 5, corridorFilter: /North|Northeast|Northwest/i },
      high_wind: { kind: 'weather', label: 'High wind alert', delayMinutes: 12, durationHours: 2, corridorFilter: null },
      track_closure: { kind: 'infrastructure', label: 'Track closure', delayMinutes: 30, durationHours: 6 },
      equipment_failure: { kind: 'infrastructure', label: 'Equipment failure', delayMinutes: 18, durationHours: 2 },
      surge_demand: { kind: 'demand', label: 'Demand surge' },
    };
    const spec = catalog[type];
    if (!spec) return null;
    this.scenarioCounter += 1;
    const id = `scenario-${this.scenarioCounter}`;
    const durationHours = params.durationHours || spec.durationHours || 3;
    const untilMinute = this.nowMinutes + durationHours * 60;

    if (spec.kind === 'demand') {
      const scenario = {
        id,
        type: 'demand',
        label: spec.label,
        auto: Boolean(params.auto),
        demandMultiplier: params.surge || 1.5,
        priceSurgeMultiplier: params.priceSurge || 1.3,
        untilMinute,
      };
      this.activeScenarios.push(scenario);
      this.logEvent('scenario', `${spec.label}: +${Math.round(((params.surge || 1.5) - 1) * 100)}% demand for ${durationHours}h.`);
      return scenario;
    }

    const scenario = {
      id,
      type: spec.kind,
      label: spec.label,
      auto: Boolean(params.auto),
      delayMinutes: params.delayMinutes || spec.delayMinutes,
      speedReduction: params.speedReduction || 0.7,
      untilMinute,
      appliedTrainIds: new Set(),
    };
    if (spec.kind === 'weather') {
      const corridors = params.corridors?.length
        ? params.corridors
        : this.pickCorridors(spec.corridorFilter, 2, id);
      scenario.affectedCorridors = new Set(corridors);
      this.logEvent('scenario', `${spec.label} over ${corridors.join(', ') || 'network'} for ${durationHours}h (+~${scenario.delayMinutes} min en route).`);
    } else {
      const routeIds = params.routeIds?.length ? params.routeIds : this.pickRouteCluster(id);
      scenario.affectedRouteIds = new Set(routeIds);
      this.logEvent('scenario', `${spec.label} affecting ${routeIds.length} route(s) for ${durationHours}h (+~${scenario.delayMinutes} min en route).`);
    }
    this.activeScenarios.push(scenario);
    return scenario;
  }

  pickCorridors(filter, count, saltKey = 'corridor-pick') {
    if (!this._corridorNames) {
      this._corridorNames = [...new Set(this.routes.map((route) => route.corridor || 'Unknown'))];
    }
    const matching = filter ? this._corridorNames.filter((name) => filter.test(name)) : this._corridorNames;
    const pool = matching.length ? matching : this._corridorNames;
    if (!pool.length) return [];
    const picked = new Set();
    for (let i = 0; i < count * 3 && picked.size < Math.min(count, pool.length); i += 1) {
      picked.add(pool[Math.floor(this.random(saltKey, i) * pool.length)]);
    }
    return [...picked];
  }

  /**
   * A real track problem affects every service sharing that piece of
   * infrastructure, so closures target a route plus its most strongly
   * station-coupled neighbors from the delay graph.
   */
  pickRouteCluster(saltKey = 'route-pick') {
    if (!this.routes.length) return [];
    const seedRoute = this.routes[Math.floor(this.random(saltKey, 'seed-route') * this.routes.length)];
    const neighbors = (this.delayGraph.get(seedRoute.id) || [])
      .slice()
      .sort((a, b) => b.couplingStrength - a.couplingStrength)
      .slice(0, 4)
      .map((entry) => entry.routeId);
    return [seedRoute.id, ...neighbors];
  }

  predictDelayLikelihood(train) {
    const factors = {
      weatherRisk: this.activeScenarios.some(s => s.type === 'weather' && s.affectedCorridors?.has(train.corridor)) ? 0.8 : 0.1,
      hubCongestion: (train.stops || []).filter(s => STATION_CAPACITIES[s.name]).length * 0.15,
      currentDelay: Math.min(1, (train.delayMinutes || 0) / 30),
    };
    const delayProbability = sigmoid(
      factors.weatherRisk * 0.4 +
      factors.hubCongestion * 0.3 +
      factors.currentDelay * 0.3 -
      1.0
    );
    return {
      probability: delayProbability,
      expectedDelayMinutes: delayProbability < 0.3 ? 0 : delayProbability < 0.6 ? 8 : 18,
    };
  }
}

/**
 * The per-route daily service floor only holds while routeCount * floor fits
 * the daily train budget. Large synthetic route sets (the 1,800-route static
 * fallback) degrade gracefully to 2 trains/route instead of overriding the
 * budget — 1,800 routes x 6 trains x 554-seat inventories exhausts the
 * browser worker heap.
 */
export function effectiveMinTrainsPerRoute(routeCount, maxTrains = DEFAULT_DAILY_TRAIN_BUDGET) {
  if (!routeCount) return MIN_DAILY_TRAINS_PER_ROUTE;
  const budget = (maxTrains === null || maxTrains === undefined || maxTrains === Infinity)
    ? DEFAULT_DAILY_TRAIN_BUDGET
    : maxTrains;
  return Math.max(2, Math.min(MIN_DAILY_TRAINS_PER_ROUTE, Math.floor((budget * 0.85) / routeCount)));
}

function allocateDailyServices(routes, maxTrains, calendar) {
  const minPerRoute = effectiveMinTrainsPerRoute(routes.length, maxTrains);
  const plans = routes.map((route) => ({
    route,
    desired: serviceCountForRoute(route, calendar, minPerRoute),
  }));
  const minTotal = routes.length * minPerRoute;
  const desiredTotal = plans.reduce((sum, plan) => sum + plan.desired, 0);
  if (maxTrains === null || maxTrains === undefined || maxTrains === Infinity) {
    return plans.map((plan) => ({ route: plan.route, serviceCount: Math.min(MAX_DAILY_TRAINS_PER_ROUTE, plan.desired) }));
  }
  const effectiveMax = Math.max(minTotal, maxTrains || DEFAULT_DAILY_TRAIN_BUDGET);
  if (desiredTotal <= effectiveMax) {
    return plans.map((plan) => ({ route: plan.route, serviceCount: Math.min(MAX_DAILY_TRAINS_PER_ROUTE, plan.desired) }));
  }

  const extraBudget = effectiveMax - minTotal;
  const desiredExtras = plans.reduce((sum, plan) => sum + Math.max(0, plan.desired - minPerRoute), 0);
  if (extraBudget <= 0 || desiredExtras <= 0) {
    return plans.map((plan) => ({ route: plan.route, serviceCount: minPerRoute }));
  }

  const scaled = plans.map((plan) => {
    const extra = Math.max(0, plan.desired - minPerRoute);
    const rawExtra = extra * extraBudget / desiredExtras;
    return {
      route: plan.route,
      serviceCount: minPerRoute + Math.floor(rawExtra),
      remainder: rawExtra - Math.floor(rawExtra),
    };
  });
  let used = scaled.reduce((sum, plan) => sum + plan.serviceCount, 0);
  const byRemainder = scaled.slice().sort((a, b) => b.remainder - a.remainder || (b.route.frequencyRank || 0) - (a.route.frequencyRank || 0));
  for (let i = 0; used < effectiveMax && i < byRemainder.length; i += 1) {
    byRemainder[i].serviceCount += 1;
    used += 1;
  }
  return scaled.map(({ route, serviceCount }) => ({ route, serviceCount: Math.min(MAX_DAILY_TRAINS_PER_ROUTE, serviceCount) }));
}

function serviceCountForRoute(route, calendar, minPerRoute = MIN_DAILY_TRAINS_PER_ROUTE) {
  const rank = Math.max(0, Math.min(1, route.frequencyRank || 0.08));
  const stops = route.stops || [];
  const originTier = stops[0]?.tier;
  const destinationTier = stops[stops.length - 1]?.tier;
  const hubScore = tierScore(originTier) + tierScore(destinationTier);
  const distance = route.totalDistanceKm || 0;
  const distanceScore = distance > 1600 ? 1.4 : distance > 900 ? 1.1 : distance > 350 ? 0.7 : 0.35;
  const serviceNoise = deterministicNoise(`${route.id}:${route.code}:service-plan`) * 1.2;
  // Flatter trunk bonus so high-rank routes don't dominate
  const trunkBonus = 1.2 + sigmoid((rank - 0.5) * 4) * 2.0;
  const baseline = minPerRoute + Math.round(1.5 + Math.sqrt(rank) * 2.4 + hubScore * 0.5 + distanceScore + serviceNoise + trunkBonus);
  const surgeExtras = Math.round(Math.max(0, baseline - minPerRoute) * Math.max(0, (calendar?.capacityMultiplier || 1) - 1) * 0.5);
  const holidayFloor = (calendar?.demandMultiplier || 1) >= 1.35 ? 1 : 0;
  return Math.min(MAX_DAILY_TRAINS_PER_ROUTE, Math.max(minPerRoute, baseline + surgeExtras + holidayFloor));
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
  // Use real travel time from 12306 database when available
  if (segment.realTravelMinutes != null && segment.realTravelMinutes > 0) {
    return Math.max(1, Math.round(segment.realTravelMinutes + dwell));
  }
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
  // Flatter corridor boost to avoid East/North China dominance
  const corridorBoost = train.corridor?.includes('East China') || train.corridor?.includes('North China') ? 0.10 : 0.06;
  const distanceBoost = train.totalDistanceKm > 900 ? 0.06 : train.totalDistanceKm < 300 ? 0.03 : 0.08;
  const hubBoost = (tierScore(train.stops[0]?.tier) + tierScore(train.stops[train.stops.length - 1]?.tier)) / 8;
  // Base load higher for low-rank routes so they don't run empty
  const baseLoad = 0.72 + Math.sqrt(rank) * 0.28 + corridorBoost + distanceBoost + hubBoost;
  return Math.max(0.55, Math.min(1.25, baseLoad));
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

function incrementRaw(map, key, train) {
  if (!map.has(key)) map.set(key, { trains: 0, active: 0, passengers: 0 });
  const value = map.get(key);
  value.trains += 1;
  if (train.status === 'running') value.active += 1;
  const segmentIndex = Math.min(Math.max(0, train.currentSegmentIndex || 0), Math.max(0, (train.segments?.length || 1) - 1));
  value.passengers += train.inventory.occupiedOnSegment(segmentIndex) || 0;
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
    stops: train._serializedStops || (train._serializedStops = train.stops.map((stop, index) => ({ name: stop.name, index }))),
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

function distanceBetween(train, originIndex, destinationIndex) {
  let total = 0;
  for (let index = originIndex; index < destinationIndex; index += 1) {
    // Use ?? so distanceKm = 0 is preserved; only null/undefined falls back to haversine.
    total += train.segments[index]?.distanceKm ?? haversineKm(train.stops[index], train.stops[index + 1]);
  }
  return total;
}

const SEAT_CLASS_FARE_KEYS = {
  business: ['商务座', '高级软卧', '软座', '一等座'],
  firstClass: ['一等座', '一等卧', '软卧', '软座', '商务座'],
  secondClass: ['二等座', '二等卧', '硬卧', '硬座', '无座'],
};

function resolveRealBaseFare(train, seatClass) {
  const fares = train.baseRoute?.fares;
  if (!fares) return null;
  const keys = SEAT_CLASS_FARE_KEYS[seatClass];
  if (!keys) return null;
  for (const key of keys) {
    const price = fares[key];
    if (price != null && price > 0) return price;
  }
  // Fallback: use the cheapest available fare scaled by typical multiplier ratios
  const available = Object.values(fares).filter((p) => p != null && p > 0);
  if (!available.length) return null;
  const cheapest = Math.min(...available);
  if (seatClass === 'business') return Math.round(cheapest * 3.0);
  if (seatClass === 'firstClass') return Math.round(cheapest * 1.7);
  return cheapest;
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

function trainDemandWeight(train) {
  // For scheduled trains, use average load across all segments instead of
  // segment 0 only, which can be misleading when bookings are distributed.
  const load = train.status === 'scheduled'
    ? train.inventory.averageLoadFactor()
    : train.inventory.occupancyForSegment(train.currentSegmentIndex || 0).loadFactor;
  const departurePressure = train.departureMinute > 0 ? Math.max(0.2, Math.min(1.5, 1.1 - Math.abs(train.departureMinute - 540) / 900)) : 1;
  // Flattened frequency rank to reduce "rich get richer" effect
  const frequencyWeight = 0.4 + Math.sqrt(Math.max(0.05, train.frequencyRank || 0.3)) * 0.6;
  // Exploration bonus: prefer trains with lower load to spread demand
  const explorationBonus = Math.max(0.2, 1.15 - load);
  return Math.max(0.15, frequencyWeight) * departurePressure * explorationBonus;
}

function prefixLowerBound(prefix, target) {
  let low = 0;
  let high = prefix.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (prefix[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Intra-day booking demand shape. Chinese HSR booking traffic is strongly
 * bimodal: a deep overnight trough (most lines do not even run 01:00-05:00),
 * a morning peak, a steady midday plateau, and an evening peak.
 */
export function hourlyDemandShape(minuteOfDay = 0) {
  const hour = minuteOfDay / 60;
  if (hour < 5) return 0.08;
  if (hour < 7) return 0.45 + (hour - 5) * 0.45;
  if (hour < 10) return 1.35;
  if (hour < 16) return 1.0;
  if (hour < 20) return 1.3;
  if (hour < 23) return 0.7;
  return 0.25;
}

function scenarioAffectsTrain(scenario, train) {
  if (scenario.affectedCorridors) return scenario.affectedCorridors.has(train.corridor);
  if (scenario.affectedRouteIds) return scenario.affectedRouteIds.has(train.routeId);
  return false;
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

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
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

function buildDelayGraph(routes) {
  const graph = new Map();
  const stationRoutes = new Map();
  for (const route of routes) {
    for (const stop of route.stops || []) {
      if (!stationRoutes.has(stop.name)) stationRoutes.set(stop.name, []);
      stationRoutes.get(stop.name).push(route.id);
    }
  }
  for (const route of routes) {
    const connected = new Map();
    for (const stop of route.stops || []) {
      for (const otherRouteId of stationRoutes.get(stop.name) || []) {
        if (otherRouteId === route.id) continue;
        connected.set(otherRouteId, (connected.get(otherRouteId) || 0) + 1);
      }
    }
    graph.set(route.id, [...connected.entries()].map(([routeId, count]) => ({
      routeId,
      couplingStrength: count,
    })));
  }
  return graph;
}
