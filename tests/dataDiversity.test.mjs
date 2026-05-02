import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('generated route database covers many corridors and origins', () => {
  const routeData = JSON.parse(fs.readFileSync(new URL('../public/route-data.json', import.meta.url), 'utf8'));

  assert.ok(routeData.simulationRouteCount >= 1000, `expected at least 1000 simulation routes, saw ${routeData.simulationRouteCount}`);
  assert.ok(routeData.diversity.uniqueOrigins >= 70, `expected broad origin coverage, saw ${routeData.diversity.uniqueOrigins}`);
  assert.ok(routeData.diversity.uniqueOriginProvinces >= 24, `expected most provincial-level regions, saw ${routeData.diversity.uniqueOriginProvinces}`);
  assert.ok(routeData.diversity.uniqueCorridors >= 20, `expected many macro-corridors, saw ${routeData.diversity.uniqueCorridors}`);
});
