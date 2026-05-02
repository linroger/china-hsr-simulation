#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.resolve(ROOT, '..');
const PUBLIC = path.join(ROOT, 'public');
const SOURCE_CANDIDATE_ROOTS = [
  SOURCE_ROOT,
  path.resolve(SOURCE_ROOT, '..', 'chinashsr copy'),
  path.resolve(SOURCE_ROOT, '..'),
];
const STATION_CSV = findSourceFile(['China-rail-way-stations-data-main/src/station.csv', 'sim/public/station.csv', 'sim/dist/station.csv']);
const LINE_CSV = findSourceFile(['China-rail-way-stations-data-main/src/line.csv', 'sim/public/line.csv', 'sim/dist/line.csv']);
const OSM_POINTS = findSourceFile(['hotosm_chn_railways_points_geojson/hotosm_chn_railways_points_geojson.geojson']);
const OSM_LINES = findSourceFile(['hotosm_chn_railways_lines_geojson/hotosm_chn_railways_lines_geojson.geojson']);
const MAX_SIMULATION_ROUTES = 1200;

fs.mkdirSync(PUBLIC, { recursive: true });

const stations = parseCsv(fs.readFileSync(STATION_CSV, 'utf8'))
  .map((row, index) => ({
    id: `st-${index}`,
    name: clean(row['站名']),
    address: clean(row['车站地址']),
    bureau: clean(row['铁路局']),
    kind: clean(row['性质']),
    province: clean(row['省']),
    city: clean(row['市']),
    lng: Number(row.WGS84_Lng),
    lat: Number(row.WGS84_Lat),
    sourceCount: Number(row.srcCount || 0),
  }))
  .filter((station) => station.name && Number.isFinite(station.lng) && Number.isFinite(station.lat))
  .map((station) => ({ ...station, tier: stationTier(station) }));

const stationByName = new Map(stations.map((station) => [station.name, station]));

const allRouteRecords = parseCsv(fs.readFileSync(LINE_CSV, 'utf8'))
  .filter((row) => ['G', 'D', 'C'].includes(clean(row.type)))
  .map((row, index) => ({
    id: `svc-${index}`,
    code: clean(row.code) ? `${clean(row.type)}${clean(row.code)}` : clean(row.station_train_code).split('(')[0],
    trainNo: clean(row.train_no),
    type: clean(row.type),
    origin: clean(row.src),
    destination: clean(row.dst),
    originKnown: stationByName.has(clean(row.src)),
    destinationKnown: stationByName.has(clean(row.dst)),
  }))
  .filter((record) => record.origin && record.destination);

const knownRoutes = allRouteRecords.filter((record) => record.originKnown && record.destinationKnown);
const serviceFrequency = new Map();
for (const record of knownRoutes) {
  const key = [record.origin, record.destination].sort().join('|');
  serviceFrequency.set(key, (serviceFrequency.get(key) || 0) + 1);
}
const maxFrequency = Math.max(...serviceFrequency.values());
const railGeojson = buildRailGeojson();
const railIndex = createRailIndex(railGeojson);

const simulationCandidates = knownRoutes
  .filter((record) => distance(stationByName.get(record.origin), stationByName.get(record.destination)) > 80)
  .map((record) => {
    const origin = stationByName.get(record.origin);
    const destination = stationByName.get(record.destination);
    return {
      ...record,
      originProvince: origin.province,
      destinationProvince: destination.province,
      distanceKm: Math.round(distance(origin, destination) * 1.12),
      corridor: corridorKey(origin, destination),
    };
  });

const simulationRoutes = selectDiverseRecords(simulationCandidates, MAX_SIMULATION_ROUTES)
  .map((record, index) => buildRoute(record, index));

const stationsGeojson = {
  type: 'FeatureCollection',
  features: stations.map((station) => ({
    type: 'Feature',
    properties: {
      id: station.id,
      name: station.name,
      province: station.province,
      city: station.city,
      tier: station.tier,
      sourceCount: station.sourceCount,
    },
    geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
  })),
};

writeJson('station-data.json', {
  generatedAt: new Date().toISOString(),
  source: 'China railway station CSV with WGS84 coordinates',
  count: stations.length,
  stations,
});
writeJson('route-data.json', {
  generatedAt: new Date().toISOString(),
  source: 'China railway train OD CSV; intermediate stops are simulation-derived from station geography',
  routeRecordCount: allRouteRecords.length,
  knownEndpointRecordCount: knownRoutes.length,
  simulationRouteCount: simulationRoutes.length,
  diversity: summarizeDiversity(simulationRoutes),
  routes: simulationRoutes,
  routeRecords: allRouteRecords,
});
writeJson('hsr-stations.geojson', stationsGeojson);
writeJson('hsr-rails.geojson', railGeojson);

console.log(`[prepare:data] stations: ${stations.length}`);
console.log(`[prepare:data] HSR service records: ${allRouteRecords.length}`);
console.log(`[prepare:data] known endpoint records: ${knownRoutes.length}`);
console.log(`[prepare:data] simulation routes: ${simulationRoutes.length}`);
console.log(`[prepare:data] unique origins: ${new Set(simulationRoutes.map((route) => route.origin)).size}`);
console.log(`[prepare:data] unique corridors: ${new Set(simulationRoutes.map((route) => route.corridor)).size}`);
console.log(`[prepare:data] rail line features: ${railGeojson.features.length}`);

function buildRoute(record, index) {
  const origin = stationByName.get(record.origin);
  const destination = stationByName.get(record.destination);
  const totalKm = distance(origin, destination) * 1.12;
  const stopTarget = Math.max(3, Math.min(12, Math.round(totalKm / 145) + 2));
  const intermediate = stations
    .filter((station) => station.name !== origin.name && station.name !== destination.name)
    .map((station) => ({ station, projection: project(origin, destination, station), detour: detourKm(origin, destination, station) }))
    .filter((item) => item.projection > 0.06 && item.projection < 0.94 && item.detour < Math.max(55, totalKm * 0.18))
    .sort((a, b) => a.detour - b.detour)
    .slice(0, stopTarget - 2)
    .sort((a, b) => a.projection - b.projection)
    .map((item) => item.station);
  const stops = [origin, ...intermediate, destination].map((station, stopIndex) => ({
    id: station.id,
    name: station.name,
    province: station.province,
    city: station.city,
    lng: station.lng,
    lat: station.lat,
    tier: station.tier,
    simulatedStop: stopIndex !== 0 && stopIndex !== intermediate.length + 1,
    dwellMinutes: station.tier === 'national-hub' ? 6 : station.tier === 'regional-hub' ? 4 : 2,
  }));
  const segments = [];
  for (let i = 0; i < stops.length - 1; i += 1) {
    const segmentDistance = distance(stops[i], stops[i + 1]) * 1.08;
    const geometry = railGeometryBetween(stops[i], stops[i + 1], railIndex);
    segments.push({
      from: stops[i].name,
      to: stops[i + 1].name,
      distanceKm: Math.round(segmentDistance),
      speedLimitKmh: segmentDistance > 180 ? 350 : segmentDistance > 80 ? 300 : 250,
      track: 'double',
      signaling: 'CTCS-3 simulated',
      geometry: geometry.coordinates,
      geometrySource: geometry.source,
    });
  }
  const key = [record.origin, record.destination].sort().join('|');
  return {
    id: `route-${index}-${record.code}`,
    code: record.code,
    trainNo: record.trainNo,
    type: record.type,
    origin: record.origin,
    destination: record.destination,
    totalDistanceKm: segments.reduce((sum, segment) => sum + segment.distanceKm, 0),
    frequencyRank: (serviceFrequency.get(key) || 1) / maxFrequency,
    corridor: record.corridor,
    originProvince: origin.province,
    destinationProvince: destination.province,
    provenance: 'Real train origin/destination; intermediate stops simulation-derived from station geography.',
    stops,
    segments,
    geometry: mergeSegmentGeometries(segments),
  };
}

function selectDiverseRecords(records, limit) {
  const byCorridor = groupBy(records, (record) => record.corridor);
  const selected = [];
  const selectedKeys = new Set();

  // Give every observed macro-corridor a baseline so the map does not collapse
  // into the first few records in line.csv.
  for (const corridorRecords of [...byCorridor.values()].sort((a, b) => b.length - a.length)) {
    const sorted = corridorRecords.slice().sort(compareRoutePriority);
    for (const record of sorted.slice(0, 4)) addRecord(record);
  }

  // Then round-robin by origin province and origin station. This keeps trunk
  // corridors dense while still allowing smaller regional services to appear.
  const byProvince = groupBy(records.slice().sort(compareRoutePriority), (record) => record.originProvince || 'unknown');
  while (selected.length < limit) {
    let madeProgress = false;
    for (const provinceRecords of byProvince.values()) {
      const next = provinceRecords.find((record) => !selectedKeys.has(recordKey(record)));
      if (next) {
        addRecord(next);
        madeProgress = true;
        if (selected.length >= limit) break;
      }
    }
    if (!madeProgress) break;
  }

  return selected.slice(0, limit);

  function addRecord(record) {
    const key = recordKey(record);
    if (selectedKeys.has(key) || selected.length >= limit) return;
    selected.push(record);
    selectedKeys.add(key);
  }
}

function compareRoutePriority(a, b) {
  const aFrequency = serviceFrequency.get([a.origin, a.destination].sort().join('|')) || 1;
  const bFrequency = serviceFrequency.get([b.origin, b.destination].sort().join('|')) || 1;
  return bFrequency - aFrequency || b.distanceKm - a.distanceKm || a.code.localeCompare(b.code, 'zh-Hans-CN');
}

function recordKey(record) {
  return `${record.trainNo}:${record.code}:${record.origin}:${record.destination}`;
}

function groupBy(items, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

function corridorKey(origin, destination) {
  const a = macroRegion(origin);
  const b = macroRegion(destination);
  return [a, b].sort().join(' / ');
}

function macroRegion(station) {
  const province = station.province || '';
  if (/北京|天津|河北|山东|山西|河南/.test(province)) return 'North China';
  if (/上海|江苏|浙江|安徽|福建|江西/.test(province)) return 'East China';
  if (/广东|广西|海南|香港|澳门/.test(province)) return 'South China';
  if (/湖北|湖南/.test(province)) return 'Central China';
  if (/重庆|四川|贵州|云南|西藏/.test(province)) return 'Southwest China';
  if (/陕西|甘肃|青海|宁夏|新疆|内蒙古/.test(province)) return 'Northwest China';
  if (/辽宁|吉林|黑龙江/.test(province)) return 'Northeast China';
  return 'Other';
}

function summarizeDiversity(routes) {
  return {
    uniqueOrigins: new Set(routes.map((route) => route.origin)).size,
    uniqueDestinations: new Set(routes.map((route) => route.destination)).size,
    uniqueOriginProvinces: new Set(routes.map((route) => route.originProvince)).size,
    uniqueCorridors: new Set(routes.map((route) => route.corridor)).size,
  };
}

function buildRailGeojson() {
  if (!fs.existsSync(OSM_LINES)) return { type: 'FeatureCollection', features: [] };
  const raw = JSON.parse(fs.readFileSync(OSM_LINES, 'utf8'));
  const features = [];
  let coordinateBudget = 0;
  for (const feature of raw.features || []) {
    if (features.length >= 8000 || coordinateBudget > 820000) break;
    const props = feature.properties || {};
    if (props.railway !== 'rail') continue;
    if (!feature.geometry || feature.geometry.type !== 'LineString') continue;
    const coordinates = feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const stride = Math.max(1, Math.ceil(coordinates.length / 80));
    const simplified = coordinates.filter((_, index) => index % stride === 0);
    const last = coordinates[coordinates.length - 1];
    if (simplified[simplified.length - 1] !== last) simplified.push(last);
    coordinateBudget += simplified.length;
    features.push({
      type: 'Feature',
      properties: {
        osm_id: props.osm_id,
        name: props.name || props['name:zh'] || '',
        gauge: props.gauge || '',
        electrified: props.electrified || '',
      },
      geometry: { type: 'LineString', coordinates: simplified },
    });
  }
  return { type: 'FeatureCollection', features };
}

function createRailIndex(railGeojson) {
  const cellSize = 0.35;
  const cells = new Map();
  for (const feature of railGeojson.features || []) {
    const coordinates = feature.geometry?.coordinates || [];
    coordinates.forEach((coord, index) => {
      const point = { lng: coord[0], lat: coord[1], index };
      const key = gridKey(point.lng, point.lat, cellSize);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(point);
    });
  }
  return { cells, cellSize };
}

function railGeometryBetween(from, to, railIndex) {
  const directKm = distance(from, to);
  const margin = Math.min(3.8, Math.max(0.55, directKm / 210));
  const minLng = Math.min(from.lng, to.lng) - margin;
  const maxLng = Math.max(from.lng, to.lng) + margin;
  const minLat = Math.min(from.lat, to.lat) - margin;
  const maxLat = Math.max(from.lat, to.lat) + margin;
  const candidates = queryRailPoints(railIndex, minLng, minLat, maxLng, maxLat)
    .map((point) => {
      const projection = project(from, to, point);
      const perpendicularKm = perpendicularDistanceKm(from, to, point);
      return { ...point, projection, perpendicularKm };
    })
    .filter((point) => point.projection > -0.12 && point.projection < 1.12)
    .filter((point) => point.perpendicularKm < Math.max(45, Math.min(220, directKm * 0.55)))
    .sort((a, b) => a.projection - b.projection);

  const sampled = sampleRailCandidates(candidates, directKm);
  if (sampled.length < 3) {
    return {
      source: 'station-straight-fallback',
      coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
    };
  }
  return {
    source: 'hotosm-rail-corridor',
    coordinates: dedupeCoordinates([[from.lng, from.lat], ...sampled.map((point) => [point.lng, point.lat]), [to.lng, to.lat]]),
  };
}

function queryRailPoints(railIndex, minLng, minLat, maxLng, maxLat) {
  const points = [];
  const minX = Math.floor(minLng / railIndex.cellSize);
  const maxX = Math.floor(maxLng / railIndex.cellSize);
  const minY = Math.floor(minLat / railIndex.cellSize);
  const maxY = Math.floor(maxLat / railIndex.cellSize);
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const cell = railIndex.cells.get(`${x}:${y}`);
      if (cell) points.push(...cell);
    }
  }
  return points;
}

function sampleRailCandidates(candidates, directKm) {
  const minSpacingKm = directKm > 220 ? 9 : 4;
  const filtered = [];
  for (const point of candidates) {
    const previous = filtered[filtered.length - 1];
    if (!previous || distance(previous, point) >= minSpacingKm) filtered.push(point);
  }
  const maxPoints = directKm > 260 ? 46 : 28;
  if (filtered.length <= maxPoints) return filtered;
  const sampled = [];
  for (let i = 0; i < maxPoints; i += 1) {
    sampled.push(filtered[Math.floor(i * (filtered.length - 1) / (maxPoints - 1))]);
  }
  return sampled;
}

function mergeSegmentGeometries(segments) {
  const coordinates = [];
  for (const segment of segments) {
    for (const coord of segment.geometry || []) {
      const previous = coordinates[coordinates.length - 1];
      if (!previous || previous[0] !== coord[0] || previous[1] !== coord[1]) coordinates.push(coord);
    }
  }
  return coordinates;
}

function dedupeCoordinates(coordinates) {
  const result = [];
  for (const coord of coordinates) {
    const previous = result[result.length - 1];
    if (!previous || distance({ lng: previous[0], lat: previous[1] }, { lng: coord[0], lat: coord[1] }) > 1) {
      result.push(coord);
    }
  }
  return result;
}

function gridKey(lng, lat, cellSize) {
  return `${Math.floor(lng / cellSize)}:${Math.floor(lat / cellSize)}`;
}

function parseCsv(text) {
  const rows = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function clean(value) {
  return String(value || '').trim();
}

function findSourceFile(relativePaths) {
  const checked = [];
  for (const root of SOURCE_CANDIDATE_ROOTS) {
    for (const relativePath of relativePaths) {
      const candidate = path.join(root, relativePath);
      checked.push(candidate);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Unable to find required source file. Checked:\n${checked.map((item) => `- ${item}`).join('\n')}`);
}

function stationTier(station) {
  const name = station.name;
  if (/北京|上海|广州|深圳|成都|重庆|武汉|郑州|西安|南京|杭州|长沙|天津/.test(name)) return 'national-hub';
  if ((station.sourceCount || 0) >= 4 || /南|西|东|北/.test(name)) return 'regional-hub';
  return 'local';
}

function distance(a, b) {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function project(a, b, p) {
  const ax = a.lng;
  const ay = a.lat;
  const bx = b.lng;
  const by = b.lat;
  const px = p.lng;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  return ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1);
}

function detourKm(a, b, p) {
  return distance(a, p) + distance(p, b) - distance(a, b);
}

function perpendicularDistanceKm(a, b, p) {
  const projection = Math.max(0, Math.min(1, project(a, b, p)));
  const projected = {
    lng: a.lng + (b.lng - a.lng) * projection,
    lat: a.lat + (b.lat - a.lat) * projection,
  };
  return distance(projected, p);
}

function radians(value) {
  return value * Math.PI / 180;
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(PUBLIC, file), `${JSON.stringify(data)}\n`);
}
