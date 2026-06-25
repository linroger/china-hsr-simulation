import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Gauge, Map, ReceiptText, TrainFront } from 'lucide-react';
import { SimulationWorkerClient } from './simulation_core/SimulationWorkerClient.js';
import { withBase } from './basePath.js';
import HSRMap from './visualization/HSRMap.jsx';
const Dashboard = lazy(() => import('./visualization/Dashboard.jsx'));
const BookingPanel = lazy(() => import('./visualization/BookingPanel.jsx'));

export default function App() {
  const workerRef = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [yearlySummary, setYearlySummary] = useState(null);
  const [loading, setLoading] = useState('Loading China HSR simulation...');
  const [activeView, setActiveView] = useState('map');
  const [speed, setSpeed] = useState(120);
  const [error, setError] = useState('');
  const [dataSource, setDataSource] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading('Loading real 12306 route data...');
        const [oceanbaseData, annualSummary] = await Promise.all([
          fetchOptionalJson(withBase('api/oceanbase-simulation-data')),
          fetchOptionalJson(withBase('oceanbase-yearly-summary.json')),
        ]);
        const { stationData, routeData, source } = oceanbaseData?.routes?.length && oceanbaseData?.stations?.length
          ? {
              stationData: { stations: oceanbaseData.stations },
              routeData: { routes: oceanbaseData.routes },
              source: `12306 DB (${oceanbaseData.routes.length.toLocaleString()} routes)`,
            }
          : await loadStaticSimulationData();
        if (cancelled) return;
        setYearlySummary(annualSummary);
        setLoading(`Starting simulation with ${source}...`);
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
          ledgerEndpoint: withBase('ingest-bookings'),
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
    // The worker already emits a full 'booking' snapshot through onSnapshot after
    // a successful booking, so an extra worker.snapshot() round-trip just builds
    // and structured-clones a second full snapshot for nothing.
    return workerRef.current?.bookTrip(payload);
  }, []);

  const injectScenario = useCallback((scenarioType, params = {}) => {
    return workerRef.current?.injectScenario(scenarioType, params);
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
        {activeView === 'dashboard' && (
          <Suspense fallback={<LoadingScreen message="Loading dashboard..." />}>
            <Dashboard snapshot={snapshot} speed={speed} onSpeedChange={handleSpeedChange} yearlySummary={yearlySummary} onInjectScenario={injectScenario} />
          </Suspense>
        )}
        {activeView === 'booking' && (
          <Suspense fallback={<LoadingScreen message="Loading booking panel..." />}>
            <BookingPanel snapshot={snapshot} quoteTrip={quoteTrip} bookTrip={bookTrip} />
          </Suspense>
        )}
      </section>
    </main>
  );
}

async function loadStaticSimulationData() {
  const [stationsResponse, routesResponse] = await Promise.all([
    fetch(withBase('station-data.json')),
    fetch(withBase('route-data.json')),
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

async function fetchOptionalJson(path, timeoutMs = 8000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
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
  if (!previous) return nextSnapshot;

  // Delta merge: update changed trains, remove vanished ones, keep the rest.
  // A delta may still carry refreshed bookingOptions (a train completed or
  // turned around) — its train list is partial either way, so it must always
  // merge rather than replace, or unchanged markers vanish from the map.
  if (nextSnapshot.delta) {
    const trainsById = Object.create(null);
    for (const train of previous.trains || []) {
      trainsById[train.id] = train;
    }
    for (const train of nextSnapshot.trains) {
      trainsById[train.id] = train;
    }
    for (const id of nextSnapshot.removedTrainIds || []) {
      delete trainsById[id];
    }
    return {
      ...nextSnapshot,
      trains: Object.values(trainsById),
      // Carry the reference forward when no refresh arrived — booking options
      // are immutable between rebuilds, so cloning 6,000 entries 5x/second is
      // wasted work.
      bookingOptions: nextSnapshot.bookingOptions || previous.bookingOptions,
    };
  }

  return {
    ...nextSnapshot,
    bookingOptions: nextSnapshot.bookingOptions || previous.bookingOptions,
  };
}
