import { useEffect, useState } from 'react';
import { Accessibility, Armchair, BadgeJapaneseYen, TicketCheck } from 'lucide-react';

const CLASS_LABELS = {
  business: 'Business / 商务座',
  firstClass: 'First / 一等座',
  secondClass: 'Second / 二等座',
};

export default function BookingPanel({ snapshot, quoteTrip, bookTrip }) {
  const trains = (snapshot.bookingOptions || snapshot.trains).filter((train) => train.stops.length >= 2);
  const [trainId, setTrainId] = useState(trains[0]?.id || '');
  const selectedTrain = trains.find((train) => train.id === trainId) || trains[0];
  const [originIndex, setOriginIndex] = useState(0);
  const [destinationIndex, setDestinationIndex] = useState(1);
  const [seatClass, setSeatClass] = useState('secondClass');
  const [preference, setPreference] = useState('any');
  const [accessible, setAccessible] = useState(false);
  const [result, setResult] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quotePending, setQuotePending] = useState(false);
  const [bookingPending, setBookingPending] = useState(false);

  const safeDestinationIndex = Math.max(originIndex + 1, Math.min(destinationIndex, (selectedTrain?.stops.length || 2) - 1));
  useEffect(() => {
    let cancelled = false;
    async function refreshQuote() {
      if (!quoteTrip || !selectedTrain) {
        setQuote(null);
        return;
      }
      setQuotePending(true);
      try {
        const nextQuote = await quoteTrip({ trainId: selectedTrain.id, originIndex, destinationIndex: safeDestinationIndex, seatClass });
        if (!cancelled) setQuote(nextQuote);
      } catch {
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setQuotePending(false);
      }
    }
    refreshQuote();
    return () => {
      cancelled = true;
    };
  }, [quoteTrip, selectedTrain?.id, originIndex, safeDestinationIndex, seatClass, snapshot.stats.totalBookings]);

  function handleTrainChange(nextTrainId) {
    setTrainId(nextTrainId);
    setOriginIndex(0);
    setDestinationIndex(1);
    setResult(null);
  }

  async function book() {
    setBookingPending(true);
    const response = await bookTrip({
      trainId: selectedTrain.id,
      originIndex,
      destinationIndex: safeDestinationIndex,
      seatClass,
      preference,
      accessible,
      passengerName: 'Dashboard Passenger',
    });
    setResult(response);
    setBookingPending(false);
  }

  return (
    <div className="booking">
      <section className="booking-form panel">
        <h2>Segment-aware Booking</h2>
        <p className="muted">Seats are held only on the requested station interval. Once a passenger alights, the same physical seat can be sold again downstream.</p>

        <label>Train</label>
        <select value={selectedTrain?.id || ''} onChange={(event) => handleTrainChange(event.target.value)}>
          {trains.map((train) => (
            <option key={train.id} value={train.id}>{train.code} · {train.origin} to {train.destination} · {train.corridor}</option>
          ))}
        </select>

        <div className="field-grid">
          <div>
            <label>Origin</label>
            <select value={originIndex} onChange={(event) => {
              const next = Number(event.target.value);
              setOriginIndex(next);
              setDestinationIndex(Math.max(next + 1, safeDestinationIndex));
            }}>
              {selectedTrain?.stops.slice(0, -1).map((stop, index) => <option key={stop.name} value={index}>{index + 1}. {stop.name}</option>)}
            </select>
          </div>
          <div>
            <label>Destination</label>
            <select value={safeDestinationIndex} onChange={(event) => setDestinationIndex(Number(event.target.value))}>
              {selectedTrain?.stops.slice(originIndex + 1).map((stop, offset) => {
                const index = originIndex + 1 + offset;
                return <option key={stop.name} value={index}>{index + 1}. {stop.name}</option>;
              })}
            </select>
          </div>
        </div>

        <div className="field-grid">
          <div>
            <label>Seat class</label>
            <select value={seatClass} onChange={(event) => setSeatClass(event.target.value)}>
              {Object.entries(CLASS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div>
            <label>Preference</label>
            <select value={preference} onChange={(event) => setPreference(event.target.value)}>
              <option value="any">Best available</option>
              <option value="window">Window</option>
              <option value="aisle">Aisle</option>
            </select>
          </div>
        </div>

        <label className="checkline">
          <input type="checkbox" checked={accessible} onChange={(event) => setAccessible(event.target.checked)} />
          <Accessibility size={16} />
          Require accessible seating
        </label>

        <button className="primary-action" disabled={!quote?.canBook || bookingPending} onClick={book}>
          <TicketCheck size={18} />
          {bookingPending ? 'Booking...' : 'Book Ticket'}
        </button>
      </section>

      <section className="quote panel">
        <h2>Quote and Allocation State</h2>
        {quote ? (
          <>
            <div className="quote-price">
              <BadgeJapaneseYen size={28} />
              <strong>¥{quote.pricing.price.toLocaleString()}</strong>
              <span>{quote.distanceKm} km · {quote.available} seats available · {quote.algorithmMs} ms · worker quote</span>
            </div>
            <div className="factor-grid">
              {Object.entries(quote.pricing.multipliers).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  <b>{value}</b>
                </div>
              ))}
            </div>
            <div className="seat-strip">
              {(selectedTrain?.stops || []).map((stop, index) => (
                <span key={stop.name} className={index >= originIndex && index < safeDestinationIndex ? 'held' : ''}>{stop.name}</span>
              ))}
            </div>
          </>
        ) : <p className="muted">{quotePending ? 'Quoting in simulation worker...' : 'Select a valid train interval to quote.'}</p>}

        {result && (
          <div className={result.ok ? 'result success' : 'result failure'}>
            <Armchair size={18} />
            {result.ok ? (
              <div>
                <b>Ticket {result.booking.ticketId}</b>
                <span>{result.booking.trainCode} · {result.booking.origin} to {result.booking.destination}</span>
                <span>{result.booking.seats.map((seat) => `Car ${seat.car} ${seat.row}${seat.letter}`).join(', ')} · ¥{result.booking.price}</span>
              </div>
            ) : (
              <div>
                <b>Booking rejected</b>
                <span>{result.reason}</span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Recent Tickets</h2>
        <div className="ticket-list">
          {(snapshot.bookings || []).map((booking) => (
            <div key={booking.ticketId} className="ticket-card">
              <b>{booking.ticketId}</b>
              <span>{booking.trainCode} · {booking.origin} to {booking.destination}</span>
              <span>{booking.seats.map((seat) => `Car ${seat.car} ${seat.row}${seat.letter}`).join(', ')} · ¥{booking.price}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
