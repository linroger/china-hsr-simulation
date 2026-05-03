import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('generated route database covers many corridors and origins', () => {
  const routeData = JSON.parse(fs.readFileSync(new URL('../public/route-data.json', import.meta.url), 'utf8'));

  assert.ok(routeData.simulationRouteCount >= 1000, `expected at least 1000 simulation routes, saw ${routeData.simulationRouteCount}`);
  assert.ok(routeData.diversity.uniqueOrigins >= 70, `expected broad origin coverage, saw ${routeData.diversity.uniqueOrigins}`);
  assert.ok(routeData.diversity.uniqueOriginProvinces >= 24, `expected most provincial-level regions, saw ${routeData.diversity.uniqueOriginProvinces}`);
  assert.ok(routeData.diversity.uniqueCorridors >= 20, `expected many macro-corridors, saw ${routeData.diversity.uniqueCorridors}`);

  const segments = routeData.routes.flatMap((route) => route.segments);
  const railMatchedSegments = segments.filter((segment) => segment.geometrySource === 'rail-traced' || segment.geometrySource === 'hotosm-rail-corridor');
  const railTracedSegments = segments.filter((segment) => segment.geometrySource === 'rail-traced');
  assert.ok(railMatchedSegments.length / segments.length >= 0.85, `expected at least 85% rail-matched segments (rail-traced + corridor-sampled), saw ${railMatchedSegments.length}/${segments.length}`);
  assert.ok(railTracedSegments.length / segments.length >= 0.5, `expected at least 50% rail-traced (graph-followed) segments, saw ${railTracedSegments.length}/${segments.length}`);
  assert.ok(railMatchedSegments.some((segment) => segment.geometry.length > 8), 'expected detailed rail polylines, not only straight station chords');

  // Validate geometry continuity - no big jumps
  let bigJumps = 0;
  let totalTransitions = 0;
  for (const segment of segments) {
    const coords = segment.geometry || [];
    for (let i = 1; i < coords.length; i += 1) {
      totalTransitions += 1;
      const dlng = Math.abs(coords[i][0] - coords[i - 1][0]);
      const dlat = Math.abs(coords[i][1] - coords[i - 1][1]);
      if (dlng > 0.5 || dlat > 0.5) bigJumps += 1;
    }
  }
  assert.ok(bigJumps / Math.max(1, totalTransitions) < 0.001, `expected <0.1% large coord jumps (>0.5 deg), saw ${bigJumps}/${totalTransitions}`);

  // Xi'an must appear (regression check for OSM augmentation)
  const xianRoutes = routeData.routes.filter((route) => /西安/.test(route.origin) || /西安/.test(route.destination));
  assert.ok(xianRoutes.length >= 10, `expected ≥10 routes involving Xi'an, saw ${xianRoutes.length}`);
});
