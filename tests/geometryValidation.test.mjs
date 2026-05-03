import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('every route segment connects continuously to the next', () => {
  const routeData = JSON.parse(fs.readFileSync(new URL('../public/route-data.json', import.meta.url), 'utf8'));
  let breaks = 0;
  let totalBoundaries = 0;
  for (const route of routeData.routes) {
    for (let i = 0; i < route.segments.length - 1; i += 1) {
      totalBoundaries += 1;
      const prev = route.segments[i].geometry;
      const next = route.segments[i + 1].geometry;
      if (!prev?.length || !next?.length) continue;
      const lastPrev = prev[prev.length - 1];
      const firstNext = next[0];
      const dlng = Math.abs(firstNext[0] - lastPrev[0]);
      const dlat = Math.abs(firstNext[1] - lastPrev[1]);
      if (dlng > 0.05 || dlat > 0.05) breaks += 1;
    }
  }
  assert.equal(breaks, 0, `expected no segment-boundary discontinuities >0.05 deg, saw ${breaks}/${totalBoundaries}`);
});

test('rail-traced segments have plausible polyline density', () => {
  const routeData = JSON.parse(fs.readFileSync(new URL('../public/route-data.json', import.meta.url), 'utf8'));
  const railTraced = routeData.routes.flatMap((route) => route.segments).filter((segment) => segment.geometrySource === 'rail-traced');
  assert.ok(railTraced.length > 1000, `expected significant rail-traced segment count, saw ${railTraced.length}`);
  const avgPoints = railTraced.reduce((sum, segment) => sum + (segment.geometry?.length || 0), 0) / railTraced.length;
  assert.ok(avgPoints >= 10, `expected ≥10 average points per rail-traced segment, saw ${avgPoints.toFixed(1)}`);
  assert.ok(avgPoints <= 80, `expected ≤80 average points per rail-traced segment (simplified), saw ${avgPoints.toFixed(1)}`);
});

test('OSM augmentation surfaces national hubs missing from station CSV', () => {
  const stationData = JSON.parse(fs.readFileSync(new URL('../public/station-data.json', import.meta.url), 'utf8'));
  const stationByName = new Map(stationData.stations.map((station) => [station.name, station]));
  const requiredHubs = ['西安北', '昆明南', '南宁东', '汉口', '贵阳北', '长沙西'];
  for (const name of requiredHubs) {
    const station = stationByName.get(name);
    assert.ok(station, `expected ${name} to exist in station database (CSV or OSM augmented)`);
    assert.ok(Number.isFinite(station.lng) && Number.isFinite(station.lat), `${name} must have valid coordinates`);
  }
});

test('route deduplication keeps OD pairs roughly unique per direction', () => {
  const routeData = JSON.parse(fs.readFileSync(new URL('../public/route-data.json', import.meta.url), 'utf8'));
  const directedPairs = new Map();
  for (const route of routeData.routes) {
    const key = `${route.origin}|${route.destination}`;
    directedPairs.set(key, (directedPairs.get(key) || 0) + 1);
  }
  let duplicates = 0;
  for (const count of directedPairs.values()) if (count > 1) duplicates += 1;
  // Stratified sampling may pick the same (origin, destination) once per
  // corridor pass for very dense trunk corridors, but full duplicates in the
  // generated set should be rare. Allow up to 5% to account for that.
  assert.ok(duplicates <= routeData.routes.length * 0.05, `expected <5% directed-pair duplicates, saw ${duplicates}/${routeData.routes.length}`);
});
