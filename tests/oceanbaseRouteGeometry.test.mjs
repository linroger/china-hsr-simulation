import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('OceanBase 12306 export follows rail-track geometry without coordinate zigzags', () => {
  const payload = JSON.parse(fs.readFileSync(new URL('../public/oceanbase-simulation-data.json', import.meta.url), 'utf8'));
  const geometry = payload.metadata?.geometry || {};
  const routes = payload.routes || [];
  assert.ok(routes.length >= 200, `expected at least 200 OceanBase routes, saw ${routes.length}`);
  assert.ok(geometry.railGraphSegments > 1500, `expected rail graph to supply most route edges, saw ${geometry.railGraphSegments || 0}`);
  assert.equal(geometry.orderedStopEdgeSegments, 0, 'long OceanBase routes should not fall back to sparse ordered-stop chords');
  assert.ok(geometry.stationCoordinateCorrections > 0, 'expected bad OceanBase station coordinates to be detected and corrected');

  const stationByName = new Map(payload.stations.map((station) => [station.name, station]));
  const jiaxing = stationByName.get('嘉兴');
  assert.ok(jiaxing, '嘉兴 should be present in the OceanBase route export');
  assert.ok(jiaxing.lng > 120 && jiaxing.lng < 121, `嘉兴 longitude should stay in Zhejiang, saw ${jiaxing.lng}`);
  assert.ok(jiaxing.lat > 30 && jiaxing.lat < 31, `嘉兴 latitude should stay in Zhejiang, saw ${jiaxing.lat}`);
  assert.match(jiaxing.coordinateSource || '', /corrected|static|track|oceanbase/);

  let checkedSegments = 0;
  let endpointMismatches = 0;
  let longSparseSegments = 0;
  let longOrderedFallbacks = 0;
  let oversizedHops = 0;
  let sharpBacktracks = 0;
  let distanceOutliers = 0;

  for (const route of routes) {
    assert.equal(route.segments.length, route.stops.length - 1, `${route.code} must have one segment per ordered stop edge`);
    for (let index = 0; index < route.segments.length; index += 1) {
      checkedSegments += 1;
      const segment = route.segments[index];
      const coords = segment.geometry || [];
      const from = route.stops[index];
      const to = route.stops[index + 1];
      const directKm = haversineKm([from.lng, from.lat], [to.lng, to.lat]);

      if (coords.length < 2) longSparseSegments += 1;
      if (coords.length >= 2) {
        if (haversineKm(coords[0], [from.lng, from.lat]) > 2 || haversineKm(coords.at(-1), [to.lng, to.lat]) > 2) {
          endpointMismatches += 1;
        }
        for (let coordIndex = 1; coordIndex < coords.length; coordIndex += 1) {
          if (haversineKm(coords[coordIndex - 1], coords[coordIndex]) > 90) oversizedHops += 1;
        }
        for (let coordIndex = 1; coordIndex < coords.length - 1; coordIndex += 1) {
          if (isSharpBacktrack(coords[coordIndex - 1], coords[coordIndex], coords[coordIndex + 1])) sharpBacktracks += 1;
        }
      }

      if (segment.distanceKm > 120 && coords.length < 4) longSparseSegments += 1;
      if ((segment.geometrySource || '').includes('ordered-stop-edge') && segment.distanceKm > 80) longOrderedFallbacks += 1;
      if (directKm > 25 && segment.distanceKm > directKm * 2.6 + 40) distanceOutliers += 1;
    }
  }

  assert.ok(checkedSegments > 1500, `expected at least 1,500 ordered route edges, saw ${checkedSegments}`);
  assert.equal(endpointMismatches, 0, `segment geometry endpoints must match ordered station endpoints; saw ${endpointMismatches}`);
  assert.equal(longSparseSegments, 0, `long segments must carry multi-point rail geometry; saw ${longSparseSegments}`);
  assert.equal(longOrderedFallbacks, 0, `long segments must not use ordered-stop straight fallback; saw ${longOrderedFallbacks}`);
  assert.equal(oversizedHops, 0, `OceanBase geometry must not contain >90 km coordinate hops; saw ${oversizedHops}`);
  assert.equal(sharpBacktracks, 0, `OceanBase geometry must not contain visible backtracking hooks; saw ${sharpBacktracks}`);
  assert.equal(distanceOutliers, 0, `OceanBase route distances should stay plausible versus station chords; saw ${distanceOutliers}`);
});

function isSharpBacktrack(previous, current, following) {
  const firstKm = haversineKm(previous, current);
  const secondKm = haversineKm(current, following);
  if (Math.min(firstKm, secondKm) < 3) return false;
  const bypassKm = haversineKm(previous, following);
  const delta = bearingDelta(previous, current, following);
  return delta > 145 && bypassKm < Math.max(firstKm, secondKm) * 0.9;
}

function bearingDelta(previous, current, following) {
  const first = bearing(previous, current);
  const second = bearing(current, following);
  const delta = Math.abs(first - second) % 360;
  return delta <= 180 ? delta : 360 - delta;
}

function bearing(a, b) {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversineKm(a, b) {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRad(value) {
  return value * Math.PI / 180;
}
