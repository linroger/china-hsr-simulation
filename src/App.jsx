import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Gauge, Map, ReceiptText, TrainFront } from 'lucide-react';
import { SimulationWorkerClient } from './simulation_core/SimulationWorkerClient.js';
import HSRMap from './visualization/HSRMap.jsx';
import Dashboard from './visualization/Dashboard.jsx';
import BookingPanel from './visualization/BookingPanel.jsx';

export default function App() {
  const workerRef = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [yearlySummary, setYearlySummary] = useState(null);
  const [loading, setLoading] = useState('Loading generated railway database...');
  const [activeView, setActiveView] = useState('map');
  const [speed, setSpeed] = useState(60);
  const [error, setError] = useState('');
  const [dataSource, setDataSource] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading('Querying OceanBase route contracts...');
        const [oceanbaseData, annualSummary] = await Promise.all([
          fetchOptionalJson('/api/oceanbase-simulation-data'),
          fetchOptionalJson('/oceanbase-yearly-summary.json'),
        ]);
        const { stationData, routeData, source } = oceanbaseData?.routes?.length && oceanbaseData?.stations?.length
          ? {
              stationData: { stations: oceanbaseData.stations },
              routeData: { routes: oceanbaseData.routes },
              source: `OceanBase 12306 (${oceanbaseData.routes.length.toLocaleString()} routes)`,
            }
          : await loadStaticSimulationData();
        if (cancelled) return;
        setYearlySummary(annualSummary);
        setLoading(`Starting simulation worker thread from ${source}...`);
        const worker = new SimulationWorkerClient({
          onSnapshot: (nextSnapshot) => {
            if (!cancelled) setSnapshot((previous) => mergeSnapshot(previous, nextSnapshot));
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
          ledgerEndpoint: '/ingest-bookings',
        });
        await worker.start();
        if (cancelled) return;
        setDataSource(source);
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
      workerRef.current = null;
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
            <p>{snapshot.stats.trainCount || snapshot.trains.length} trains · {snapshot.stats.activeTrains || 0} active · {snapshot.stats.totalPassengers.toLocaleString()} passengers · ¥{Math.round(snapshot.stats.totalRevenue).toLocaleString()}{dataSource ? ` · ${dataSource}` : ''}</p>
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
          <span>{formatSimulationClock(snapshot)}</span>
        </div>
      </header>

      <section className="workspace">
        {activeView === 'map' && <HSRMap trains={snapshot.trains} events={snapshot.events} />}
        {activeView === 'dashboard' && <Dashboard snapshot={snapshot} speed={speed} onSpeedChange={handleSpeedChange} yearlySummary={yearlySummary} />}
        {activeView === 'booking' && <BookingPanel snapshot={snapshot} quoteTrip={quoteTrip} bookTrip={bookTrip} />}
      </section>
    </main>
  );
}

async function loadStaticSimulationData() {
  const [stationsResponse, routesResponse] = await Promise.all([
    fetch('/station-data.json'),
    fetch('/route-data.json'),
  ]);
  if (!stationsResponse.ok || !routesResponse.ok) {
    throw new Error('Generated data is missing. Run ./init.sh or npm run prepare:data first.');
  }
  const [stationData, routeData] = await Promise.all([
    stationsResponse.json(),
    routesResponse.json(),
  ]);
  return { stationData, routeData, source: 'static generated JSON fallback' };
}

async function fetchOptionalJson(path) {
  try {
    const response = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.includes('application/json')) return null;
    return await response.json();
  } catch {
    return null;
  }
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

function formatSimulationClock(snapshot) {
  const calendar = snapshot.calendar;
  const time = calendar?.clock || formatClock(snapshot.nowMinutes);
  const date = calendar?.dateLabel ? `${calendar.dateLabel} ${calendar.dayName}` : 'Jan 1';
  const label = calendar?.label && calendar.label !== 'Normal weekday' ? ` · ${calendar.label}` : '';
  return `${date} · ${time}${label}`;
}

function mergeSnapshot(previous, nextSnapshot) {
  if (!previous || nextSnapshot.bookingOptions) return nextSnapshot;
  return {
    ...nextSnapshot,
    bookingOptions: previous.bookingOptions.slice(),
  };
}
