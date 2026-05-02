# China HSR Simulation

A browser-based, data-backed simulation of China high-speed rail operations with segment-aware booking, seat reuse after alighting, dynamic ticket pricing, live train movement, and a Mapbox dashboard.

## Data Sources

- `../China-rail-way-stations-data-main/src/station.csv`: station names, administrative metadata, and WGS84 coordinates.
- `../China-rail-way-stations-data-main/src/line.csv`: real train origin-destination service records.
- `../hotosm_chn_railways_points_geojson/hotosm_chn_railways_points_geojson.geojson`: OSM railway points.
- `../hotosm_chn_railways_lines_geojson/hotosm_chn_railways_lines_geojson.geojson`: OSM railway lines.

The route database uses real stations and real train origin-destination records. Because the local train CSV does not include every train's complete stop-by-stop timetable, intermediate stops are generated from geographically plausible stations between real endpoints and are labeled as simulation-derived.

## Secret Handling

Do not put Mapbox secret tokens in this app. The browser uses a public token. You can override the default public token by copying `.env.example` to `.env` and setting `VITE_MAPBOX_TOKEN`.

## Commands

```bash
npm install
./init.sh
npm run serve
```

Quality gates:

```bash
npm test
npm run build
npm run verify
```

The stable local browser URL is `http://127.0.0.1:5174/`. `npm run serve` serves the verified production bundle from `dist/`; `npm run dev` is still available for HMR development on the same fixed port.

If the in-app browser says the site refused to connect, the app server is not running. Rebuild and serve it with:

```bash
npm run build
npm run serve
```

For this local desktop session the server was also submitted to `launchctl` under `com.codex.china-hsr-simulation`, so `http://127.0.0.1:5174/` stays reachable outside the transient shell command.

## Booking Model

Every seat stores a calendar of occupied intervals `[originStationIndex, destinationStationIndex)`. A new booking may use that seat only when its requested interval does not overlap any existing interval. Therefore:

- A passenger booked from Beijing South to Jinan West blocks the seat through the Jinan West arrival segment.
- A passenger boarding at Jinan West may reuse the same seat after the first passenger alights.
- A passenger boarding before Jinan West for a trip that overlaps the original interval must receive another seat or be rejected.

Dynamic pricing combines route distance, seat class, segment scarcity, booking horizon, peak-hour demand, and route service frequency.

## Implementation Layout

- `scripts/prepare-data.cjs` builds the local station, route, and Mapbox layer database.
- `src/algorithms/seatInventory.js` implements the interval calendar, seat preferences, group seating, accessibility constraints, and seat release/cancellation.
- `src/algorithms/pricing.js` implements distance fares, class multipliers, bid-price scarcity, peak/time-to-departure effects, no-show buffer, and elasticity metadata.
- `src/simulation_core/SimulationEngine.js` drives the discrete-event train clock, train positions, station events, quotes, bookings, cancellations, and dashboard snapshots.
- `src/simulation_core/simulationWorker.js` runs the simulation engine in a browser Web Worker so train updates, live demand, pricing, booking, and snapshots execute off the React/Mapbox UI thread.
- `src/simulation_core/SimulationWorkerClient.js` is the main-thread message bridge for worker snapshots, booking, quotes, and speed controls.
- `src/visualization/` contains the Mapbox map, operations dashboard, and booking workflow.
- `tests/` contains deterministic regression checks for interval seat reuse, pricing behavior, and engine booking state mutation.

## Verified State

The current harness passes:

```bash
./init.sh
```

That script regenerates the data artifacts, runs the booking/pricing tests, builds the production bundle, and scans the project for secret-looking Mapbox tokens.
