import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CalendarDays, CircleDollarSign, Cpu, Database, Gauge, Timer, TrainFront, TrendingUp, Users } from 'lucide-react';

export default function Dashboard({ snapshot, speed, onSpeedChange, yearlySummary }) {
  const trains = snapshot.trains || [];

  const topLoads = useMemo(() =>
    trains.slice().sort((a, b) => b.loadFactor - a.loadFactor).slice(0, 18),
    [trains]
  );

  const revenueSeries = useMemo(() =>
    buildRevenueSeries(snapshot.bookings || []),
    [snapshot.bookings]
  );

  const annual = yearlySummary;

  return (
    <div className="dashboard">
      <section className="metric-grid">
        <Metric icon={<CircleDollarSign />} label="Revenue" value={formatCurrencyCompact(snapshot.stats.totalRevenue)} />
        <Metric icon={<Users />} label="Passengers booked" value={snapshot.stats.totalPassengers.toLocaleString()} />
        <Metric icon={<TrainFront />} label="Active / total trains" value={`${snapshot.stats.activeTrains || 0}/${snapshot.stats.trainCount || trains.length}`} />
        <Metric icon={<Timer />} label="Visible on map" value={snapshot.stats.visibleTrainCount || trains.length} />
        <Metric icon={<CalendarDays />} label="Calendar day" value={`${snapshot.stats.simulationDate || 'Jan 1'} ${snapshot.stats.simulationClock || ''}`} />
        <Metric icon={<CalendarDays />} label="Year progress" value={`${snapshot.stats.currentServiceDayNumber || 1}/${snapshot.stats.simulationYearDays || 365}`} />
        <Metric icon={<TrendingUp />} label="Demand surge" value={`${snapshot.stats.calendarLabel || 'Normal'} · ${snapshot.stats.calendarDemandMultiplier || 1}x`} />
        <Metric icon={<CircleDollarSign />} label="Price surge" value={`${snapshot.stats.calendarPriceSurgeMultiplier || 1}x`} />
        <Metric icon={<Timer />} label="Active avg delay" value={`${snapshot.stats.activeAverageDelayMinutes || 0} min`} />
        <Metric icon={<Users />} label="No-show releases" value={snapshot.stats.noShows || 0} />
        <Metric icon={<TrainFront />} label="Simulation thread" value={snapshot.worker?.thread || 'main'} />
        <Metric icon={<Gauge />} label="Worker cadence" value={`${snapshot.worker?.snapshotIntervalMs || '—'} ms`} />
        <Metric icon={<Users />} label="Seat quota / train" value={snapshot.stats.seatQuotaPerTrain || 554} />
        <Metric icon={<TrainFront />} label="Trains / route" value={`${snapshot.stats.trainsPerRoute || '—'} avg`} />
        <Metric icon={<TrainFront />} label="Route daily range" value={`${snapshot.stats.minTrainsPerRoute || 0}-${snapshot.stats.maxTrainsPerRoute || 0}`} />
        <Metric icon={<TrainFront />} label="Cumulative live trains" value={(snapshot.stats.cumulativeTrainServices || snapshot.stats.trainCount || 0).toLocaleString()} />
        {annual && <Metric icon={<Database />} label="Annual trains" value={annual.totalTrainServices.toLocaleString()} />}
        {annual && <Metric icon={<Users />} label="Annual passengers" value={annual.estimatedPassengers.toLocaleString()} />}
        {annual && <Metric icon={<CircleDollarSign />} label="Annual revenue" value={formatCurrencyCompact(annual.estimatedRevenue)} />}
        {annual && <Metric icon={<Cpu />} label="Annual workers" value={`${annual.workerCount}/${annual.cpuCount} cores`} />}
      </section>

      <section className="control-strip">
        <label htmlFor="speed">Simulation speed</label>
        <input id="speed" type="range" min="1" max="120" step="1" value={speed} onChange={(event) => onSpeedChange(Number(event.target.value))} />
        <strong>{speed}x</strong>
      </section>

      <section className="chart-grid">
        <div className="panel">
          <h2>Highest Segment Loads</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={topLoads}>
              <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false} />
              <XAxis dataKey="code" tick={{ fill: '#8ea3bd', fontSize: 11 }} interval={0} angle={-35} textAnchor="end" height={55} />
              <YAxis tick={{ fill: '#8ea3bd', fontSize: 11 }} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
              <Tooltip formatter={(value) => `${(value * 100).toFixed(1)}%`} contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }} />
              <Bar dataKey="loadFactor" fill="#38bdf8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="panel">
          <h2>Recent Booking Revenue</h2>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={revenueSeries}>
              <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#8ea3bd', fontSize: 11 }} />
              <YAxis tick={{ fill: '#8ea3bd', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }} />
              <Line type="monotone" dataKey="revenue" stroke="#f59e0b" strokeWidth={3} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="chart-grid">
        <div className="panel">
          <h2>Station Platform Pressure</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={(snapshot.network?.stationHotspots || []).slice(0, 14)}>
              <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: '#8ea3bd', fontSize: 10 }} interval={0} angle={-28} textAnchor="end" height={70} />
              <YAxis tick={{ fill: '#8ea3bd', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }} />
              <Bar dataKey="active" fill="#f97316" radius={[4, 4, 0, 0]} />
              <Bar dataKey="passengers" fill="#a78bfa" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="panel">
          <h2>Operational Realism</h2>
          <div className="realism-grid">
            <Realism label="Station stops processed" value={snapshot.stats.stationStops || 0} />
            <Realism label="Active delayed trains >= 3 min" value={snapshot.stats.activeDelayedTrains || 0} />
            <Realism label="No-show seats released" value={snapshot.stats.noShows || 0} />
            <Realism label="Map render cap" value={snapshot.stats.visibleTrainCount || trains.length} />
            <Realism label="Median trains per route" value={snapshot.stats.medianTrainsPerRoute || 0} />
            <Realism label="Calendar capacity multiplier" value={`${snapshot.stats.calendarCapacityMultiplier || 1}x`} />
          </div>
        </div>
      </section>

      {annual && (
        <section className="chart-grid">
          <div className="panel">
            <h2>OceanBase Year Simulation</h2>
            <div className="realism-grid">
              <Realism label="Run ID" value={annual.runId} />
              <Realism label="Service dates" value={`${annual.startDate} to ${annual.endDate}`} />
              <Realism label="Route-day rows" value={annual.routeDayRows.toLocaleString()} />
              <Realism label="Surge days" value={annual.surgeDayCount} />
              <Realism label="Daily train avg" value={annual.dailyAverages?.trainServices?.toLocaleString()} />
              <Realism label="Annual revenue exact" value={`¥${Math.round(annual.estimatedRevenue).toLocaleString()}`} />
            </div>
          </div>
          <div className="panel">
            <h2>OceanBase Table Counts</h2>
            <div className="realism-grid">
              <Realism label="Stations" value={annual.oceanbase?.tables?.stations?.toLocaleString() || '—'} />
              <Realism label="Routes" value={annual.oceanbase?.tables?.routes?.toLocaleString() || '—'} />
              <Realism label="Route stops" value={annual.oceanbase?.tables?.routeStops?.toLocaleString() || '—'} />
              <Realism label="Route segments" value={annual.oceanbase?.tables?.routeSegments?.toLocaleString() || '—'} />
              <Realism label="Route variants" value={annual.oceanbase?.tables?.routeVariants?.toLocaleString() || annual.routeContract?.routeVariants?.toLocaleString() || '—'} />
              <Realism label="Variant stops" value={annual.oceanbase?.tables?.routeVariantStops?.toLocaleString() || annual.routeContract?.routeVariantStops?.toLocaleString() || '—'} />
              <Realism label="Rail tracks" value={annual.oceanbase?.tables?.railTracks?.toLocaleString() || annual.routeContract?.railTracks?.toLocaleString() || '—'} />
              <Realism label="Daily service facts" value={annual.oceanbase?.tables?.dailyRouteServicesForRun?.toLocaleString() || '—'} />
              <Realism label="Render backend" value={annual.architecture?.rendering || 'Mapbox WebGL'} />
            </div>
          </div>
        </section>
      )}

      <section className="chart-grid">
        <div className="panel">
          <h2>Corridor Coverage</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={(snapshot.network?.corridors || []).slice(0, 14)}>
              <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: '#8ea3bd', fontSize: 10 }} interval={0} angle={-28} textAnchor="end" height={70} />
              <YAxis tick={{ fill: '#8ea3bd', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }} />
              <Bar dataKey="trains" fill="#22c55e" radius={[4, 4, 0, 0]} />
              <Bar dataKey="active" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="panel">
          <h2>Origin Province Coverage</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={(snapshot.network?.originProvinces || []).slice(0, 16)}>
              <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: '#8ea3bd', fontSize: 10 }} interval={0} angle={-28} textAnchor="end" height={70} />
              <YAxis tick={{ fill: '#8ea3bd', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }} />
              <Bar dataKey="trains" fill="#38bdf8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="panel train-table">
        <h2>Train Operations</h2>
        <div className="table">
          {trains.slice(0, 40).map((train) => (
            <div className="train-row" key={train.id}>
              <b>{train.code}</b>
              <span>{train.currentStation} to {train.nextStation}</span>
              <meter min="0" max="1" low="0.5" high="0.85" optimum="0.7" value={train.loadFactor} />
              <em>{(train.loadFactor * 100).toFixed(1)}%</em>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Realism({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function buildRevenueSeries(bookings) {
  let total = 0;
  return bookings.slice().reverse().map((booking, index) => {
    total += booking.price;
    return { label: `${index + 1}`, revenue: total };
  });
}

function formatCurrencyCompact(value) {
  return `¥${new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(Math.round(value || 0))}`;
}
