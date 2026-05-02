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
    return this.seats
      .filter((seat) => !seatClass || seat.seatClass === seatClass)
      .filter((seat) => !accessible || seat.accessible)
      .filter((seat) => this.isSeatAvailable(seat.id, originIndex, destinationIndex))
      .sort((a, b) => scoreSeat(b, preference, originIndex, destinationIndex) - scoreSeat(a, preference, originIndex, destinationIndex));
  }

  allocate({ originIndex, destinationIndex, seatClass, passengerId, ticketId, preference = 'any', accessible = false, groupSize = 1 }) {
    this.validateInterval(originIndex, destinationIndex);
    if (groupSize < 1 || groupSize > 6) {
      throw new Error('Group bookings support 1 to 6 passengers in this simulator.');
    }
    const candidates = this.availableSeats({ originIndex, destinationIndex, seatClass, accessible, preference });
    if (candidates.length < groupSize) return null;

    const group = chooseGroup(candidates, groupSize);
    for (const seat of group) {
      seat.intervals.push({ originIndex, destinationIndex, passengerId, ticketId });
      seat.intervals.sort((a, b) => a.originIndex - b.originIndex || a.destinationIndex - b.destinationIndex);
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

  releaseTicket(ticketId) {
    let released = 0;
    for (const seat of this.seats) {
      const before = seat.intervals.length;
      seat.intervals = seat.intervals.filter((interval) => interval.ticketId !== ticketId);
      released += before - seat.intervals.length;
    }
    return released;
  }

  occupancyForSegment(segmentIndex, seatClass = null) {
    const relevantSeats = this.seats.filter((seat) => !seatClass || seat.seatClass === seatClass);
    const occupied = relevantSeats.filter((seat) => seat.intervals.some((held) => held.originIndex <= segmentIndex && segmentIndex < held.destinationIndex)).length;
    return {
      occupied,
      capacity: relevantSeats.length,
      loadFactor: relevantSeats.length ? occupied / relevantSeats.length : 0,
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
      this.availableSeats({ originIndex, destinationIndex, seatClass }).length,
    ]));
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
