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

test('long routes prefer hub stations on actual HSR mainline (no local coastal halts)', () => {
  const routeData = JSON.parse(fs.readFileSync(new URL('../public/route-data.json', import.meta.url), 'utf8'));
  const longRoutes = routeData.routes.filter((route) => route.totalDistanceKm >= 1000);
  assert.ok(longRoutes.length >= 30, `expected ≥30 long-distance routes, saw ${longRoutes.length}`);

  // For long routes, intermediate stops must be majority HSR-grade
  // (national-hub or regional-hub). Simulation routes that pick local coastal
  // halts as intermediate stops cause the rail-traced A* to wander off the
  // actual HSR mainline.
  let routesWithLocalHeavyStops = 0;
  for (const route of longRoutes) {
    const intermediate = route.stops.slice(1, -1);
    if (!intermediate.length) continue;
    const localCount = intermediate.filter((stop) => stop.tier === 'local').length;
    if (localCount / intermediate.length > 0.4) routesWithLocalHeavyStops += 1;
  }
  assert.ok(
    routesWithLocalHeavyStops / longRoutes.length < 0.05,
    `expected <5% of long routes to have >40% local-tier intermediate stops, saw ${routesWithLocalHeavyStops}/${longRoutes.length}`,
  );

  // Beijing南 → 上海虹桥 (the real 京沪高铁) should hit at least Tianjin/Cangzhou,
  // Jinan, Nanjing, and Suzhou/Wuxi area in some form.
  const bjsh = routeData.routes.find((route) => route.origin === '北京南' && route.destination === '上海虹桥');
  if (bjsh) {
    const stopNames = bjsh.stops.map((stop) => stop.name);
    const expectedAnchors = [
      ['天津', '沧州', '廊坊'],   // northern anchor
      ['济南', '德州', '泰安'],   // mid anchor
      ['南京', '徐州', '蚌埠'],   // central anchor
      ['苏州', '无锡', '常州'],   // southern anchor
    ];
    let hits = 0;
    for (const group of expectedAnchors) {
      if (stopNames.some((name) => group.some((anchor) => name.includes(anchor)))) hits += 1;
    }
    assert.ok(
      hits >= 3,
      `Beijing-Shanghai stops should anchor on at least 3 of the 4 京沪高铁 corridor regions; saw ${hits}/4 in ${stopNames.join(' / ')}`,
    );
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
