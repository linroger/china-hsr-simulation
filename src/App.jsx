import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Gauge, Map, ReceiptText, TrainFront } from 'lucide-react';
import { SimulationWorkerClient } from './simulation_core/SimulationWorkerClient.js';
import HSRMap from './visualization/HSRMap.jsx';
import Dashboard from './visualization/Dashboard.jsx';
import BookingPanel from './visualization/BookingPanel.jsx';

export default function App() {
  const workerRef = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState('Loading generated railway database...');
  const [activeView, setActiveView] = useState('map');
  const [speed, setSpeed] = useState(18);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [stationsResponse, routesResponse] = await Promise.all([
          fetch('/station-data.json'),
          fetch('/route-data.json'),
        ]);
        if (!stationsResponse.ok || !routesResponse.ok) {
          throw new Error('Generated data is missing. Run ./init.sh or npm run prepare:data first.');
        }
        const stationData = await stationsResponse.json();
        const routeData = await routesResponse.json();
        if (cancelled) return;
        setLoading('Starting simulation worker thread...');
        const worker = new SimulationWorkerClient({
          onSnapshot: (nextSnapshot) => {
            if (!cancelled) setSnapshot(nextSnapshot);
          },
          onError: (message) => {
            if (!cancelled) setError(message);
          },
        });
        workerRef.current = worker;
        await worker.init({
          stations: stationData.stations,
          routes: routeData.routes,
          speed,
        });
        await worker.start();
        setLoading('');
      } catch (err) {
        setError(err.message);
        setLoading('');
      }
    }
    load();
    return () => {
      cancelled = true;
      workerRef.current?.terminate();
    };
  }, []);

  function handleSpeedChange(nextSpeed) {
    setSpeed(nextSpeed);
    workerRef.current?.setSpeed(nextSpeed);
  }

  const quoteTrip = useCallback((payload) => {
    return workerRef.current?.quoteTrip(payload);
  }, []);

  const bookTrip = useCallback(async (payload) => {
    const result = await workerRef.current?.bookTrip(payload);
    const nextSnapshot = await workerRef.current?.snapshot();
    if (nextSnapshot) setSnapshot(nextSnapshot);
    return result;
  }, []);

  const activeIcon = useMemo(() => ({
    map: <Map size={16} />,
    dashboard: <Gauge size={16} />,
    booking: <ReceiptText size={16} />,
  }), []);

  if (loading) return <LoadingScreen message={loading} />;
  if (error) return <ErrorScreen message={error} />;
  if (!snapshot) return <LoadingScreen message="Starting simulation engine..." />;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <TrainFront size={28} />
          <div>
            <h1>China HSR Simulation</h1>
            <p>{snapshot.stats.trainCount || snapshot.trains.length} trains · {snapshot.stats.activeTrains || 0} active · {snapshot.stats.totalBookings} bookings · ¥{Math.round(snapshot.stats.totalRevenue).toLocaleString()}</p>
          </div>
        </div>
        <nav className="view-tabs" aria-label="Simulation views">
          {[
            ['map', 'Map'],
            ['dashboard', 'Dashboard'],
            ['booking', 'Booking'],
          ].map(([id, label]) => (
            <button key={id} className={activeView === id ? 'active' : ''} onClick={() => setActiveView(id)}>
              {activeView === id ? activeIcon[id] : null}
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="clock">
          <Activity size={15} />
          <span>{formatClock(snapshot.nowMinutes)}</span>
        </div>
      </header>

      <section className="workspace">
        {activeView === 'map' && <HSRMap trains={snapshot.trains} events={snapshot.events} />}
        {activeView === 'dashboard' && <Dashboard snapshot={snapshot} speed={speed} onSpeedChange={handleSpeedChange} />}
        {activeView === 'booking' && <BookingPanel snapshot={snapshot} quoteTrip={quoteTrip} bookTrip={bookTrip} />}
      </section>
    </main>
  );
}

function LoadingScreen({ message }) {
  return (
    <div className="center-screen">
      <TrainFront size={44} />
      <h1>China HSR Simulation</h1>
      <p>{message}</p>
    </div>
  );
}

function ErrorScreen({ message }) {
  return (
    <div className="center-screen error">
      <h1>Unable to start</h1>
      <p>{message}</p>
    </div>
  );
}

function formatClock(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60).toString().padStart(2, '0');
  const minute = Math.floor(normalized % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}
