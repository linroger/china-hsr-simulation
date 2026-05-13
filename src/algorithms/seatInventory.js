export const SEAT_CLASSES = {
  business: {
    label: 'Business',
    cn: '商务座',
    multiplier: 3.1,
    cars: 1,
    rowCount: 5,
    layout: ['A', 'F'],
    accessibleRows: [1],
  },
  firstClass: {
    label: 'First',
    cn: '一等座',
    multiplier: 1.75,
    cars: 3,
    rowCount: 17,
    layout: ['A', 'C', 'D', 'F'],
    accessibleRows: [1, 2],
  },
  secondClass: {
    label: 'Second',
    cn: '二等座',
    multiplier: 1,
    cars: 4,
    rowCount: 17,
    layout: ['A', 'B', 'C', 'D', 'F'],
    accessibleRows: [1, 2],
  },
};

export const CLASS_ORDER = ['business', 'firstClass', 'secondClass'];

export function createSeatMap() {
  const seats = [];
  for (const seatClass of CLASS_ORDER) {
    const config = SEAT_CLASSES[seatClass];
    for (let carOffset = 0; carOffset < config.cars; carOffset += 1) {
      const car = carOffset + 1 + (seatClass === 'firstClass' ? 1 : seatClass === 'secondClass' ? 4 : 0);
      for (let row = 1; row <= config.rowCount; row += 1) {
        for (const letter of config.layout) {
          seats.push({
            id: `${seatClass}:${car}-${row}${letter}`,
            seatClass,
            car,
            row,
            letter,
            position: ['A', 'F'].includes(letter) ? 'window' : ['C', 'D'].includes(letter) ? 'aisle' : 'middle',
            accessible: config.accessibleRows.includes(row),
            intervals: [],
          });
        }
      }
    }
  }
  return seats;
}

export function intervalOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export class SeatInventory {
  constructor(routeStations, seats = createSeatMap()) {
    if (!Array.isArray(routeStations) || routeStations.length < 2) {
      throw new Error('SeatInventory requires at least two route stations.');
    }
    this.routeStations = routeStations;
    this.seats = seats.map((seat) => ({ ...seat, intervals: [...(seat.intervals || [])] }));
    this.seatById = new Map(this.seats.map((seat) => [seat.id, seat]));
    this.seatsByClass = new Map();
    this.capacityByClass = new Map();
    this.segmentLoadsByClass = new Map();
    this.segmentLoadsTotal = Array.from({ length: routeStations.length - 1 }, () => 0);
    this.ticketIndex = new Map(); // ticketId -> [{ seat, interval }]
    for (const seat of this.seats) {
      if (!this.seatsByClass.has(seat.seatClass)) this.seatsByClass.set(seat.seatClass, []);
      this.seatsByClass.get(seat.seatClass).push(seat);
    }
    for (const seatClass of CLASS_ORDER) {
      const seatsForClass = this.seatsByClass.get(seatClass) || [];
      this.capacityByClass.set(seatClass, seatsForClass.length);
      this.segmentLoadsByClass.set(seatClass, Array.from({ length: routeStations.length - 1 }, () => 0));
    }
    for (const seat of this.seats) {
      for (const interval of seat.intervals) {
        this.adjustSegmentLoads(seat.seatClass, interval.originIndex, interval.destinationIndex, 1);
        if (interval.ticketId) {
          if (!this.ticketIndex.has(interval.ticketId)) this.ticketIndex.set(interval.ticketId, []);
          this.ticketIndex.get(interval.ticketId).push({ seat, interval });
        }
      }
    }
  }

  clone() {
    return new SeatInventory(
      this.routeStations,
      this.seats.map((seat) => ({ ...seat, intervals: seat.intervals.map((i) => ({ ...i })) })),
    );
  }

  validateInterval(originIndex, destinationIndex) {
    if (!Number.isInteger(originIndex) || !Number.isInteger(destinationIndex)) {
      throw new Error('Station indexes must be integers.');
    }
    if (originIndex < 0 || destinationIndex > this.routeStations.length - 1 || originIndex >= destinationIndex) {
      throw new Error(`Invalid travel interval [${originIndex}, ${destinationIndex}).`);
    }
  }

  isSeatAvailable(seatId, originIndex, destinationIndex) {
    this.validateInterval(originIndex, destinationIndex);
    const seat = this.seatById.get(seatId);
    if (!seat) return false;
    return seat.intervals.every((held) => !intervalOverlaps(originIndex, destinationIndex, held.originIndex, held.destinationIndex));
  }

  availableSeats({ originIndex, destinationIndex, seatClass, accessible = false, preference = 'any' }) {
    this.validateInterval(originIndex, destinationIndex);
    const pool = seatClass ? this.seatsByClass.get(seatClass) || [] : this.seats;
    return pool
      .filter((seat) => !accessible || seat.accessible)
      .filter((seat) => this.isSeatAvailable(seat.id, originIndex, destinationIndex))
      .sort((a, b) => scoreSeat(b, preference, originIndex, destinationIndex) - scoreSeat(a, preference, originIndex, destinationIndex));
  }

  availabilityCount({ originIndex, destinationIndex, seatClass, accessible = false }) {
    this.validateInterval(originIndex, destinationIndex);
    const pool = seatClass ? this.seatsByClass.get(seatClass) || [] : this.seats;
    let count = 0;
    for (const seat of pool) {
      if ((!accessible || seat.accessible) && this.isSeatAvailable(seat.id, originIndex, destinationIndex)) count += 1;
    }
    return count;
  }

  canFitGroup({ originIndex, destinationIndex, seatClass, groupSize = 1 }) {
    this.validateInterval(originIndex, destinationIndex);
    const capacity = seatClass ? this.capacityByClass.get(seatClass) || 0 : this.seats.length;
    if (groupSize > capacity) return false;
    const loads = seatClass ? this.segmentLoadsByClass.get(seatClass) : this.segmentLoadsTotal;
    for (let segment = originIndex; segment < destinationIndex; segment += 1) {
      if (((loads?.[segment] || 0) + groupSize) > capacity) return false;
    }
    return true;
  }

  allocate({ originIndex, destinationIndex, seatClass, passengerId, ticketId, preference = 'any', accessible = false, groupSize = 1 }) {
    this.validateInterval(originIndex, destinationIndex);
    if (groupSize < 1 || groupSize > 6) {
      throw new Error('Group bookings support 1 to 6 passengers in this simulator.');
    }
    if (!this.canFitGroup({ originIndex, destinationIndex, seatClass, groupSize })) return null;
    const group = this.findAllocationGroup({ originIndex, destinationIndex, seatClass, accessible, preference, groupSize });
    if (!group) return null;
    for (const seat of group) {
      const interval = { originIndex, destinationIndex, passengerId, ticketId };
      seat.intervals.push(interval);
      seat.intervals.sort((a, b) => a.originIndex - b.originIndex || a.destinationIndex - b.destinationIndex);
      this.adjustSegmentLoads(seat.seatClass, originIndex, destinationIndex, 1);
      if (ticketId) {
        if (!this.ticketIndex.has(ticketId)) this.ticketIndex.set(ticketId, []);
        this.ticketIndex.get(ticketId).push({ seat, interval });
      }
    }
    return group.map((seat) => ({
      seatId: seat.id,
      seatClass: seat.seatClass,
      car: seat.car,
      row: seat.row,
      letter: seat.letter,
      position: seat.position,
      accessible: seat.accessible,
    }));
  }

  findAllocationGroup({ originIndex, destinationIndex, seatClass, accessible, preference, groupSize }) {
    if (preference !== 'any' || accessible) {
      const candidates = this.availableSeats({ originIndex, destinationIndex, seatClass, accessible, preference });
      return candidates.length >= groupSize ? chooseGroup(candidates, groupSize) : null;
    }

    const pool = seatClass ? this.seatsByClass.get(seatClass) || [] : this.seats;
    const byCarRow = new Map();
    const fallback = [];
    const rowCapacity = seatClass ? SEAT_CLASSES[seatClass]?.layout.length || 5 : 5;
    for (const seat of pool) {
      if (!this.isSeatAvailable(seat.id, originIndex, destinationIndex)) continue;
      if (groupSize === 1) return [seat];
      fallback.push(seat);
      const key = `${seat.car}-${seat.row}`;
      if (!byCarRow.has(key)) byCarRow.set(key, []);
      const seats = byCarRow.get(key);
      seats.push(seat);
      if (seats.length >= groupSize) return seats.slice(0, groupSize);
      if (fallback.length >= groupSize && groupSize > rowCapacity) return fallback.slice(0, groupSize);
    }
    return fallback.length >= groupSize ? fallback.slice(0, groupSize) : null;
  }

  releaseTicket(ticketId) {
    const entries = this.ticketIndex.get(ticketId);
    if (!entries) return 0;
    let released = 0;
    for (const { seat, interval } of entries) {
      const before = seat.intervals.length;
      seat.intervals = seat.intervals.filter((i) => i !== interval);
      if (seat.intervals.length < before) {
        this.adjustSegmentLoads(seat.seatClass, interval.originIndex, interval.destinationIndex, -1);
        released += 1;
      }
    }
    this.ticketIndex.delete(ticketId);
    return released;
  }

  occupiedOnSegment(segmentIndex) {
    return this.segmentLoadsTotal[segmentIndex] || 0;
  }

  occupancyForSegment(segmentIndex, seatClass = null) {
    const capacity = seatClass ? this.capacityByClass.get(seatClass) || 0 : this.seats.length;
    const occupied = seatClass
      ? this.segmentLoadsByClass.get(seatClass)?.[segmentIndex] || 0
      : this.segmentLoadsTotal[segmentIndex] || 0;
    return {
      occupied,
      capacity,
      loadFactor: capacity ? occupied / capacity : 0,
    };
  }

  maxLoad(originIndex, destinationIndex, seatClass = null) {
    this.validateInterval(originIndex, destinationIndex);
    let max = { occupied: 0, capacity: 0, loadFactor: 0 };
    for (let segment = originIndex; segment < destinationIndex; segment += 1) {
      const load = this.occupancyForSegment(segment, seatClass);
      if (load.loadFactor > max.loadFactor) max = load;
    }
    return max;
  }

  averageLoadFactor(seatClass = null) {
    const capacity = seatClass ? this.capacityByClass.get(seatClass) || 0 : this.seats.length;
    if (!capacity) return 0;
    const loads = seatClass ? this.segmentLoadsByClass.get(seatClass) : this.segmentLoadsTotal;
    if (!loads?.length) return 0;
    const total = loads.reduce((sum, v) => sum + (v || 0), 0);
    return total / (loads.length * capacity);
  }

  seatTimeline(seatId) {
    const seat = this.seatById.get(seatId);
    if (!seat) return [];
    return seat.intervals.map((interval) => ({
      ...interval,
      origin: this.routeStations[interval.originIndex]?.name,
      destination: this.routeStations[interval.destinationIndex]?.name,
    }));
  }

  classAvailability(originIndex, destinationIndex) {
    return Object.fromEntries(CLASS_ORDER.map((seatClass) => [
      seatClass,
      this.availabilityCount({ originIndex, destinationIndex, seatClass }),
    ]));
  }

  adjustSegmentLoads(seatClass, originIndex, destinationIndex, delta) {
    const classLoads = this.segmentLoadsByClass.get(seatClass);
    for (let segment = originIndex; segment < destinationIndex; segment += 1) {
      if (classLoads) classLoads[segment] = Math.max(0, (classLoads[segment] || 0) + delta);
      this.segmentLoadsTotal[segment] = Math.max(0, (this.segmentLoadsTotal[segment] || 0) + delta);
    }
  }
}

function scoreSeat(seat, preference, originIndex, destinationIndex) {
  const tripLength = destinationIndex - originIndex;
  const preferenceBonus =
    preference === seat.position ? 100 :
    preference === 'any' && tripLength >= 4 && seat.position === 'window' ? 30 :
    preference === 'any' && tripLength < 4 && seat.position === 'aisle' ? 20 :
    0;
  const reuseBonus = seat.intervals.length * 5;
  const rowPenalty = seat.row * 0.01;
  return preferenceBonus + reuseBonus - rowPenalty;
}

function chooseGroup(candidates, groupSize) {
  if (groupSize === 1) return [candidates[0]];
  const byCarRow = new Map();
  for (const seat of candidates) {
    const key = `${seat.car}-${seat.row}`;
    if (!byCarRow.has(key)) byCarRow.set(key, []);
    byCarRow.get(key).push(seat);
  }
  for (const seats of byCarRow.values()) {
    if (seats.length >= groupSize) return seats.slice(0, groupSize);
  }
  return candidates.slice(0, groupSize);
}
