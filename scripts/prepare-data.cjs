#!/usr/bin/env node
/*
 * China HSR Simulation - Data Pipeline ETL
 *
 * Inputs:
 *   - China-rail-way-stations-data-main/src/station.csv      (3,058 stations w/ WGS-84)
 *   - China-rail-way-stations-data-main/src/line.csv         (7,278 G/D/C train OD records)
 *   - hotosm_chn_railways_points_geojson                     (16,527 OSM stations + halts)
 *   - hotosm_chn_railways_lines_geojson                      (347,135 OSM rail LineStrings)
 *
 * Outputs in public/:
 *   - station-data.json      Augmented station database (CSV + OSM-supplemented missing stations)
 *   - route-data.json        Deduplicated simulation routes with rail-traced geometries
 *   - hsr-stations.geojson   Mapbox station Point features
 *   - hsr-rails.geojson      Mapbox rail LineString features
 *
 * Major algorithms:
 *   1. Station augmentation — OSM points fill gaps (西安北, 昆明南, 南宁东, etc.)
 *   2. Rail graph construction — coordinate dedup + adjacency map
 *   3. Path-following geometry — Dijkstra over rail nodes between station endpoints
 *   4. Stratified diversity sampling — corridor + province coverage
 *   5. Geometry validation — flags & repairs segments with big coord jumps
 */

const fs = require('fs');
const path = require('path');

class BinaryHeap {
  constructor() {
    this.items = [];
  }
  size() {
    return this.items.length;
  }
  push(item) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return top;
  }
  bubbleUp(index) {
    const item = this.items[index];
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].score <= item.score) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  sinkDown(index) {
    const length = this.items.length;
    const item = this.items[index];
    while (true) {
      const left = (index << 1) + 1;
      const right = left + 1;
      let target = index;
      if (left < length && this.items[left].score < this.items[target].score) target = left;
      if (right < length && this.items[right].score < this.items[target].score) target = right;
      if (target === index) break;
      this.items[index] = this.items[target];
      index = target;
    }
    this.items[index] = item;
  }
}

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.resolve(ROOT, '..');
const PUBLIC = path.join(ROOT, 'public');
const SOURCE_CANDIDATE_ROOTS = [
  SOURCE_ROOT,
  path.resolve(SOURCE_ROOT, '..', 'chinashsr copy'),
  path.resolve(SOURCE_ROOT, '..'),
];
const STATION_CSV = findSourceFile([
  'China-rail-way-stations-data-main/src/station.csv',
  'sim/public/station.csv',
  'sim/dist/station.csv',
]);
const LINE_CSV = findSourceFile([
  'China-rail-way-stations-data-main/src/line.csv',
  'sim/public/line.csv',
  'sim/dist/line.csv',
]);
const OSM_POINTS = findSourceFileOptional([
  'hotosm_chn_railways_points_geojson/hotosm_chn_railways_points_geojson.geojson',
]);
const OSM_LINES = findSourceFileOptional([
  'hotosm_chn_railways_lines_geojson/hotosm_chn_railways_lines_geojson.geojson',
]);
const MAX_SIMULATION_ROUTES = 1200;

const RAIL_LINE_FEATURE_BUDGET = 12000;
const RAIL_LINE_VERTEX_BUDGET = 1_400_000;

const STATION_LOOKUP_TIER_OVERRIDES = new Map([
  // Major HSR hubs that must be classified as national-hub even if name parser misses.
  ['西安北', 'national-hub'],
  ['西安', 'national-hub'],
  ['北京', 'national-hub'],
  ['北京南', 'national-hub'],
  ['北京西', 'national-hub'],
  ['北京北', 'national-hub'],
  ['北京东', 'national-hub'],
  ['上海', 'national-hub'],
  ['上海虹桥', 'national-hub'],
  ['上海南', 'national-hub'],
  ['广州', 'national-hub'],
  ['广州南', 'national-hub'],
  ['深圳', 'national-hub'],
  ['深圳北', 'national-hub'],
  ['成都', 'national-hub'],
  ['成都东', 'national-hub'],
  ['成都西', 'national-hub'],
  ['重庆', 'national-hub'],
  ['重庆北', 'national-hub'],
  ['重庆西', 'national-hub'],
  ['武汉', 'national-hub'],
  ['汉口', 'national-hub'],
  ['武昌', 'national-hub'],
  ['郑州', 'national-hub'],
  ['郑州东', 'national-hub'],
  ['南京', 'national-hub'],
  ['南京南', 'national-hub'],
  ['杭州', 'national-hub'],
  ['杭州东', 'national-hub'],
  ['长沙', 'national-hub'],
  ['长沙南', 'national-hub'],
  ['长沙西', 'national-hub'],
  ['天津', 'national-hub'],
  ['天津南', 'national-hub'],
  ['天津西', 'national-hub'],
  ['昆明南', 'national-hub'],
  ['昆明', 'national-hub'],
  ['南宁东', 'national-hub'],
  ['南宁', 'national-hub'],
  ['福州', 'national-hub'],
  ['福州南', 'national-hub'],
  ['厦门北', 'national-hub'],
  ['厦门', 'national-hub'],
  ['哈尔滨', 'national-hub'],
  ['哈尔滨西', 'national-hub'],
  ['沈阳', 'national-hub'],
  ['沈阳北', 'national-hub'],
  ['沈阳南', 'national-hub'],
  ['大连', 'national-hub'],
  ['大连北', 'national-hub'],
  ['长春', 'national-hub'],
  ['长春西', 'national-hub'],
  ['济南', 'national-hub'],
  ['济南西', 'national-hub'],
  ['青岛', 'national-hub'],
  ['青岛北', 'national-hub'],
  ['合肥', 'national-hub'],
  ['合肥南', 'national-hub'],
  ['南昌', 'national-hub'],
  ['南昌西', 'national-hub'],
  ['贵阳', 'national-hub'],
  ['贵阳北', 'national-hub'],
  ['乌鲁木齐', 'national-hub'],
  ['呼和浩特', 'national-hub'],
  ['银川', 'national-hub'],
  ['西宁', 'national-hub'],
  ['兰州', 'national-hub'],
  ['兰州西', 'national-hub'],
  ['太原', 'national-hub'],
  ['太原南', 'national-hub'],
  ['石家庄', 'national-hub'],
  ['香港西九龙', 'national-hub'],
]);

fs.mkdirSync(PUBLIC, { recursive: true });

console.log('[prepare:data] reading source datasets...');
const csvStations = parseCsv(fs.readFileSync(STATION_CSV, 'utf8'))
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
    source: 'csv',
  }))
  .filter((station) => station.name && Number.isFinite(station.lng) && Number.isFinite(station.lat));

const allRouteRecords = parseCsv(fs.readFileSync(LINE_CSV, 'utf8'))
  .filter((row) => ['G', 'D', 'C'].includes(clean(row.type)))
  .map((row, index) => ({
    id: `svc-${index}`,
    code: clean(row.code) ? `${clean(row.type)}${clean(row.code)}` : clean(row.station_train_code).split('(')[0],
    trainNo: clean(row.train_no),
    type: clean(row.type),
    origin: clean(row.src),
    destination: clean(row.dst),
  }))
  .filter((record) => record.origin && record.destination);

console.log(`[prepare:data] csv stations: ${csvStations.length}`);
console.log(`[prepare:data] csv route records: ${allRouteRecords.length}`);

// Build name index from CSV first; OSM augments missing names.
const stations = csvStations.slice();
const stationIndex = new Map(); // name -> station
for (const station of stations) stationIndex.set(station.name, station);

let osmAugmentedCount = 0;
if (OSM_POINTS && fs.existsSync(OSM_POINTS)) {
  const osmPoints = JSON.parse(fs.readFileSync(OSM_POINTS, 'utf8'));
  const referencedNames = new Set();
  for (const record of allRouteRecords) {
    if (record.origin) referencedNames.add(record.origin);
    if (record.destination) referencedNames.add(record.destination);
  }

  const osmByName = new Map();
  for (const feature of osmPoints.features || []) {
    const props = feature.properties || {};
    if (!feature.geometry || feature.geometry.type !== 'Point') continue;
    const candidates = collectNameCandidates(props);
    if (!candidates.length) continue;
    const [lng, lat] = feature.geometry.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    for (const name of candidates) {
      if (!osmByName.has(name)) osmByName.set(name, { lng, lat, props });
    }
  }

  for (const referencedName of referencedNames) {
    if (stationIndex.has(referencedName)) continue;
    const candidate = osmByName.get(referencedName)
      || osmByName.get(`${referencedName}站`)
      || osmByName.get(`${referencedName}火车站`);
    if (!candidate) continue;
    const station = {
      id: `osm-${osmAugmentedCount}`,
      name: referencedName,
      address: '',
      bureau: '',
      kind: candidate.props.railway === 'station' ? '客运站' : '简易站',
      province: '',
      city: '',
      lng: candidate.lng,
      lat: candidate.lat,
      sourceCount: 0,
      source: 'osm-augmented',
    };
    osmAugmentedCount += 1;
    stations.push(station);
    stationIndex.set(referencedName, station);
  }
  console.log(`[prepare:data] osm-augmented stations: ${osmAugmentedCount}`);
}

inferProvinceCity(stations);

for (const station of stations) {
  station.tier = stationTier(station);
}
const stationByName = stationIndex;

// Update route records with known/unknown status now that augmentation is complete.
const enrichedRouteRecords = allRouteRecords.map((record) => ({
  ...record,
  originKnown: stationByName.has(record.origin),
  destinationKnown: stationByName.has(record.destination),
}));

const knownRoutes = enrichedRouteRecords.filter((record) => record.originKnown && record.destinationKnown);
const serviceFrequency = new Map();
for (const record of knownRoutes) {
  const key = [record.origin, record.destination].sort().join('|');
  serviceFrequency.set(key, (serviceFrequency.get(key) || 0) + 1);
}
const maxFrequency = Math.max(1, ...serviceFrequency.values());

console.log(`[prepare:data] known endpoint records: ${knownRoutes.length} (${((knownRoutes.length / enrichedRouteRecords.length) * 100).toFixed(1)}%)`);

console.log('[prepare:data] reading OSM rail lines...');
const osmRailFeatures = readOsmRailFeatures();
console.log(`[prepare:data] OSM rail features parsed: ${osmRailFeatures.length}`);

console.log('[prepare:data] building rail line dataset for rendering...');
const railGeojson = buildRailGeojson(osmRailFeatures);
console.log(`[prepare:data] rail line features (rendering): ${railGeojson.features.length}`);

console.log('[prepare:data] building rail network graph (full detail) for path-following geometry...');
const railNetwork = buildRailNetwork(osmRailFeatures);
console.log(`[prepare:data] rail nodes: ${railNetwork.nodeCount}, edges: ${railNetwork.edgeCount}`);

const simulationCandidatesRaw = knownRoutes
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

console.log(`[prepare:data] simulation candidates pre-dedupe: ${simulationCandidatesRaw.length}`);
const simulationCandidates = deduplicateByOd(simulationCandidatesRaw);
console.log(`[prepare:data] simulation candidates post-dedupe: ${simulationCandidates.length}`);

const stationLookupForGeometry = createStationSpatialIndex(stations);

const geometryStats = {
  railTraced: 0,
  railCorridorSampled: 0,
  straightFallback: 0,
  repairedJumps: 0,
  totalSegments: 0,
};

const simulationRoutes = selectDiverseRecords(simulationCandidates, MAX_SIMULATION_ROUTES)
  .map((record, index) => buildRoute(record, index));

console.log(`[prepare:data] simulation routes: ${simulationRoutes.length}`);
console.log(`[prepare:data] segment geometry sources: rail-traced=${geometryStats.railTraced} (${pct(geometryStats.railTraced, geometryStats.totalSegments)}%), rail-corridor-sampled=${geometryStats.railCorridorSampled} (${pct(geometryStats.railCorridorSampled, geometryStats.totalSegments)}%), straight-fallback=${geometryStats.straightFallback} (${pct(geometryStats.straightFallback, geometryStats.totalSegments)}%)`);
console.log(`[prepare:data] segments repaired due to jumps: ${geometryStats.repairedJumps}`);

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
      source: station.source,
    },
    geometry: { type: 'Point', coordinates: [station.lng, station.lat] },
  })),
};

writeJson('station-data.json', {
  generatedAt: new Date().toISOString(),
  source: 'China rail station CSV with WGS84 coordinates + OSM augmentation for HSR-only stations',
  count: stations.length,
  csvCount: csvStations.length,
  osmAugmentedCount,
  stations,
});
writeJson('route-data.json', {
  generatedAt: new Date().toISOString(),
  source: 'China railway train OD CSV; intermediate stops simulation-derived; geometry path-traced over OSM rail graph when possible',
  routeRecordCount: enrichedRouteRecords.length,
  knownEndpointRecordCount: knownRoutes.length,
  simulationRouteCount: simulationRoutes.length,
  diversity: summarizeDiversity(simulationRoutes),
  geometry: {
    totalSegments: geometryStats.totalSegments,
    railTraced: geometryStats.railTraced,
    railCorridorSampled: geometryStats.railCorridorSampled,
    straightFallback: geometryStats.straightFallback,
    repairedJumps: geometryStats.repairedJumps,
  },
  routes: simulationRoutes,
  routeRecords: enrichedRouteRecords,
});
writeJson('hsr-stations.geojson', stationsGeojson);
writeJson('hsr-rails.geojson', railGeojson);

console.log(`[prepare:data] stations: ${stations.length} (csv: ${csvStations.length}, osm: ${osmAugmentedCount})`);
console.log(`[prepare:data] HSR service records: ${enrichedRouteRecords.length}`);
console.log(`[prepare:data] known endpoint records: ${knownRoutes.length}`);
console.log(`[prepare:data] simulation routes: ${simulationRoutes.length}`);
console.log(`[prepare:data] unique origins: ${new Set(simulationRoutes.map((route) => route.origin)).size}`);
console.log(`[prepare:data] unique corridors: ${new Set(simulationRoutes.map((route) => route.corridor)).size}`);
console.log(`[prepare:data] rail line features: ${railGeojson.features.length}`);

// ============================================================================
// Route building
// ============================================================================

function buildRoute(record, index) {
  const origin = stationByName.get(record.origin);
  const destination = stationByName.get(record.destination);
  const totalKm = distance(origin, destination) * 1.12;
  const stopTarget = Math.max(3, Math.min(12, Math.round(totalKm / 145) + 2));
  const intermediate = pickIntermediateStops(origin, destination, totalKm, stopTarget);
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
    const geometry = railGeometryBetween(stops[i], stops[i + 1]);
    geometryStats.totalSegments += 1;
    if (geometry.source === 'rail-traced') geometryStats.railTraced += 1;
    else if (geometry.source === 'hotosm-rail-corridor') geometryStats.railCorridorSampled += 1;
    else geometryStats.straightFallback += 1;
    segments.push({
      from: stops[i].name,
      to: stops[i + 1].name,
      distanceKm: Math.round(segmentDistance),
      speedLimitKmh: segmentDistance > 180 ? 350 : segmentDistance > 80 ? 300 : 250,
      track: 'double',
      signaling: 'CTCS-3 simulated',
      geometry: roundCoordinates(geometry.coordinates),
      geometrySource: geometry.source,
      geometryDistanceKm: geometry.distanceKm ? Math.round(geometry.distanceKm * 10) / 10 : null,
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
    provenance: 'Real train origin/destination; intermediate stops simulation-derived from station geography; geometry path-traced over OSM rail graph when possible.',
    stops,
    segments,
    geometry: mergeSegmentGeometries(segments),
  };
}

function pickIntermediateStops(origin, destination, totalKm, stopTarget) {
  const corridorWidth = Math.max(45, Math.min(140, totalKm * 0.18));
  return stations
    .filter((station) => station.name !== origin.name && station.name !== destination.name)
    .map((station) => ({
      station,
      projection: project(origin, destination, station),
      detour: detourKm(origin, destination, station),
    }))
    .filter((item) => item.projection > 0.06 && item.projection < 0.94 && item.detour < corridorWidth)
    .sort((a, b) => a.detour - b.detour)
    .slice(0, stopTarget - 2)
    .sort((a, b) => a.projection - b.projection)
    .map((item) => item.station);
}

function deduplicateByOd(records) {
  const byPair = new Map();
  for (const record of records) {
    const key = `${record.origin}|${record.destination}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, record);
      continue;
    }
    const existingFrequency = serviceFrequency.get([existing.origin, existing.destination].sort().join('|')) || 1;
    const recordFrequency = serviceFrequency.get([record.origin, record.destination].sort().join('|')) || 1;
    if (recordFrequency > existingFrequency) byPair.set(key, record);
    else if (recordFrequency === existingFrequency && record.code.localeCompare(existing.code, 'zh-Hans-CN') < 0) byPair.set(key, record);
  }
  return [...byPair.values()];
}

function selectDiverseRecords(records, limit) {
  const byCorridor = groupBy(records, (record) => record.corridor);
  const selected = [];
  const selectedKeys = new Set();

  for (const corridorRecords of [...byCorridor.values()].sort((a, b) => b.length - a.length)) {
    const sorted = corridorRecords.slice().sort(compareRoutePriority);
    for (const record of sorted.slice(0, 4)) addRecord(record);
  }

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
  return `${record.origin}:${record.destination}`;
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

// ============================================================================
// Rail dataset & graph
// ============================================================================

function readOsmRailFeatures() {
  if (!OSM_LINES || !fs.existsSync(OSM_LINES)) return [];
  const raw = JSON.parse(fs.readFileSync(OSM_LINES, 'utf8'));
  const items = [];
  for (const feature of raw.features || []) {
    const props = feature.properties || {};
    if (props.railway !== 'rail') continue;
    if (!feature.geometry || feature.geometry.type !== 'LineString') continue;
    const coordinates = feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    items.push({ coordinates, props, coordCount: coordinates.length });
  }
  return items;
}

function buildRailGeojson(osmFeatures) {
  if (!osmFeatures.length) return { type: 'FeatureCollection', features: [] };
  // Prioritize HSR-named lines, then longer lines.
  const hsrPattern = /高速|客运|城际|动车|高铁|高速线|高速铁路/;
  const isHsr = (item) => hsrPattern.test(item.props.name || '') || hsrPattern.test(item.props['name:zh'] || '');
  const sorted = osmFeatures.slice().sort((a, b) => {
    const aHsr = isHsr(a) ? 1 : 0;
    const bHsr = isHsr(b) ? 1 : 0;
    if (aHsr !== bHsr) return bHsr - aHsr;
    return b.coordCount - a.coordCount;
  });

  const features = [];
  let coordinateBudget = 0;
  for (const item of sorted) {
    if (features.length >= RAIL_LINE_FEATURE_BUDGET || coordinateBudget > RAIL_LINE_VERTEX_BUDGET) break;
    const coordinates = item.coordinates;
    const stride = Math.max(1, Math.ceil(coordinates.length / 80));
    const simplified = coordinates.filter((_, index) => index % stride === 0);
    const last = coordinates[coordinates.length - 1];
    if (simplified[simplified.length - 1] !== last) simplified.push(last);
    coordinateBudget += simplified.length;
    features.push({
      type: 'Feature',
      properties: {
        osm_id: item.props.osm_id,
        name: item.props.name || item.props['name:zh'] || '',
        gauge: item.props.gauge || '',
        electrified: item.props.electrified || '',
        usage: item.props.usage || '',
        hsr: isHsr(item) ? 1 : 0,
      },
      geometry: { type: 'LineString', coordinates: simplified },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Build a coordinate-level graph from rail features. Adjacent vertices in the
 * same LineString form edges. Coordinates within ~600m get unified into the
 * same node so different LineStrings can connect at junctions, but small
 * enough that real curves are preserved.
 */
function buildRailNetwork(osmFeatures) {
  const cellSize = 0.0055; // ~600m at China's latitudes
  const cellMap = new Map();
  const nodes = []; // { lng, lat, neighbors: Set<nodeIndex>, refCount }

  function nodeKey(lng, lat) {
    return `${Math.round(lng / cellSize)}:${Math.round(lat / cellSize)}`;
  }

  function findOrCreateNode(lng, lat) {
    const key = nodeKey(lng, lat);
    const existing = cellMap.get(key);
    if (existing !== undefined) {
      const node = nodes[existing];
      node.lng = (node.lng * node.refCount + lng) / (node.refCount + 1);
      node.lat = (node.lat * node.refCount + lat) / (node.refCount + 1);
      node.refCount += 1;
      return existing;
    }
    const id = nodes.length;
    nodes.push({ lng, lat, refCount: 1, neighbors: new Set() });
    cellMap.set(key, id);
    return id;
  }

  let edgeCount = 0;
  for (const feature of osmFeatures) {
    const coordinates = feature.coordinates;
    let prevId = null;
    for (const [lng, lat] of coordinates) {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const id = findOrCreateNode(lng, lat);
      if (prevId !== null && prevId !== id) {
        if (!nodes[prevId].neighbors.has(id)) {
          nodes[prevId].neighbors.add(id);
          nodes[id].neighbors.add(prevId);
          edgeCount += 1;
        }
      }
      prevId = id;
    }
  }

  // Convert neighbor Sets to arrays for faster iteration during Dijkstra.
  for (const node of nodes) {
    node.neighborList = [...node.neighbors];
    node.neighbors = null;
  }

  // Spatial bucket index for fast nearest-node lookup
  const lookupCellSize = 0.04;
  const lookupCells = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const key = `${Math.floor(node.lng / lookupCellSize)}:${Math.floor(node.lat / lookupCellSize)}`;
    if (!lookupCells.has(key)) lookupCells.set(key, []);
    lookupCells.get(key).push(i);
  }

  return {
    nodes,
    nodeCount: nodes.length,
    edgeCount,
    lookupCellSize,
    lookupCells,
    findNearestNode(lng, lat, maxKm = 25) {
      const cellX = Math.floor(lng / lookupCellSize);
      const cellY = Math.floor(lat / lookupCellSize);
      let best = -1;
      let bestKm = maxKm;
      const maxRadius = Math.ceil(maxKm / 4);
      for (let radius = 0; radius <= maxRadius; radius += 1) {
        let foundAny = false;
        for (let dx = -radius; dx <= radius; dx += 1) {
          for (let dy = -radius; dy <= radius; dy += 1) {
            if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
            const key = `${cellX + dx}:${cellY + dy}`;
            const bucket = lookupCells.get(key);
            if (!bucket) continue;
            foundAny = true;
            for (const nodeId of bucket) {
              const node = nodes[nodeId];
              const km = distance({ lng, lat }, node);
              if (km < bestKm) {
                best = nodeId;
                bestKm = km;
              }
            }
          }
        }
        if (best >= 0 && foundAny) break;
      }
      return best >= 0 ? { id: best, km: bestKm } : null;
    },
  };
}

function createStationSpatialIndex(stations) {
  const cellSize = 0.5;
  const cells = new Map();
  for (const station of stations) {
    const key = `${Math.floor(station.lng / cellSize)}:${Math.floor(station.lat / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(station);
  }
  return { cells, cellSize };
}

/**
 * Compute a polyline between two stations:
 *  1. Try the rail graph: snap both endpoints to the nearest rail node, run a
 *     bounded Dijkstra search, and follow the resulting node path.
 *  2. If that fails or wanders too far, fall back to corridor sampling: pick
 *     candidate rail vertices that lie roughly along the chord.
 *  3. As last resort, fall back to a straight chord.
 *
 * Always validates the result for big jumps and patches them.
 */
function railGeometryBetween(from, to) {
  const directKm = distance(from, to);

  const traced = traceOverRailGraph(from, to, directKm);
  if (traced) return traced;

  const corridorSampled = sampleRailCorridor(from, to, directKm);
  if (corridorSampled) return corridorSampled;

  return {
    source: 'station-straight-fallback',
    coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
    distanceKm: directKm,
  };
}

function traceOverRailGraph(from, to, directKm) {
  const fromAttachKm = directKm > 800 ? 18 : directKm > 400 ? 14 : 10;
  const fromNode = railNetwork.findNearestNode(from.lng, from.lat, fromAttachKm);
  const toNode = railNetwork.findNearestNode(to.lng, to.lat, fromAttachKm);
  if (!fromNode || !toNode || fromNode.id === toNode.id) return null;

  const path = dijkstraPath(railNetwork, fromNode.id, toNode.id, directKm);
  if (!path || path.nodes.length < 2) return null;

  const pathDistanceKm = path.distanceKm;
  if (pathDistanceKm > directKm * 1.85 + 12) return null;

  const coords = [[from.lng, from.lat]];
  for (const nodeId of path.nodes) {
    const node = railNetwork.nodes[nodeId];
    coords.push([node.lng, node.lat]);
  }
  coords.push([to.lng, to.lat]);

  // Simplify with Douglas-Peucker to keep ≤ ~70 vertices per segment.
  // Tolerance scales with segment length: short hops keep more detail.
  const tolerance = directKm > 600 ? 0.0035
                  : directKm > 250 ? 0.002
                  : directKm > 100 ? 0.0012
                  : 0.0008;
  const simplified = simplifyDouglasPeucker(coords, tolerance);
  const capped = capVertexCount(simplified, directKm > 800 ? 70 : directKm > 300 ? 55 : 38);

  const cleaned = repairBigJumps(capped);
  if (cleaned.repaired) geometryStats.repairedJumps += 1;
  return {
    source: 'rail-traced',
    coordinates: cleaned.coordinates,
    distanceKm: pathDistanceKm,
  };
}

function simplifyDouglasPeucker(coords, tolerance) {
  if (coords.length <= 2) return coords.slice();
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start <= 1) continue;
    let maxDist = 0;
    let maxIndex = -1;
    const ax = coords[start][0];
    const ay = coords[start][1];
    const bx = coords[end][0];
    const by = coords[end][1];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    for (let i = start + 1; i < end; i += 1) {
      const px = coords[i][0];
      const py = coords[i][1];
      let perp;
      if (lengthSq === 0) {
        const ddx = px - ax;
        const ddy = py - ay;
        perp = Math.sqrt(ddx * ddx + ddy * ddy);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
        const projX = ax + t * dx;
        const projY = ay + t * dy;
        const ddx = px - projX;
        const ddy = py - projY;
        perp = Math.sqrt(ddx * ddx + ddy * ddy);
      }
      if (perp > maxDist) {
        maxDist = perp;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance && maxIndex > 0) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }
  const result = [];
  for (let i = 0; i < coords.length; i += 1) {
    if (keep[i]) result.push(coords[i]);
  }
  return result;
}

function capVertexCount(coords, maxVertices) {
  if (coords.length <= maxVertices) return coords;
  const result = [coords[0]];
  const step = (coords.length - 1) / (maxVertices - 1);
  for (let i = 1; i < maxVertices - 1; i += 1) {
    result.push(coords[Math.round(i * step)]);
  }
  result.push(coords[coords.length - 1]);
  return result;
}

/**
 * Bounded A* search with a binary heap priority queue. Uses straight-line
 * distance to the goal as an admissible heuristic. Caps total exploration to
 * avoid pathological wandering on disconnected components.
 */
function dijkstraPath(network, startId, goalId, directKm) {
  const { nodes } = network;
  const goalNode = nodes[goalId];
  const distances = new Map();
  const previous = new Map();
  distances.set(startId, 0);
  const visited = new Set();
  const heap = new BinaryHeap();
  const startH = distance(nodes[startId], goalNode);
  heap.push({ id: startId, dist: 0, score: startH });

  const maxKm = Math.max(180, directKm * 2.2);
  let iterations = 0;
  const iterationCap = 60000;

  while (heap.size() > 0 && iterations < iterationCap) {
    iterations += 1;
    const current = heap.pop();
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    if (current.id === goalId) {
      const nodesPath = [];
      let cur = goalId;
      while (cur !== undefined && cur !== null) {
        nodesPath.unshift(cur);
        cur = previous.get(cur);
      }
      return { nodes: nodesPath, distanceKm: current.dist };
    }

    if (current.dist > maxKm) continue;

    const node = nodes[current.id];
    const neighborList = node.neighborList;
    for (let n = 0; n < neighborList.length; n += 1) {
      const neighborId = neighborList[n];
      if (visited.has(neighborId)) continue;
      const neighbor = nodes[neighborId];
      const edgeKm = distance(node, neighbor);
      const newDist = current.dist + edgeKm;
      if (newDist > maxKm) continue;
      const existing = distances.get(neighborId);
      if (existing === undefined || newDist < existing) {
        distances.set(neighborId, newDist);
        previous.set(neighborId, current.id);
        heap.push({ id: neighborId, dist: newDist, score: newDist + distance(neighbor, goalNode) });
      }
    }
  }
  return null;
}

function sampleRailCorridor(from, to, directKm) {
  if (!railNetwork.nodes.length) return null;
  const margin = Math.min(2.5, Math.max(0.4, directKm / 250));
  const minLng = Math.min(from.lng, to.lng) - margin;
  const maxLng = Math.max(from.lng, to.lng) + margin;
  const minLat = Math.min(from.lat, to.lat) - margin;
  const maxLat = Math.max(from.lat, to.lat) + margin;
  const cellSize = railNetwork.lookupCellSize;
  const minX = Math.floor(minLng / cellSize);
  const maxX = Math.floor(maxLng / cellSize);
  const minY = Math.floor(minLat / cellSize);
  const maxY = Math.floor(maxLat / cellSize);
  const candidates = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const bucket = railNetwork.lookupCells.get(`${x}:${y}`);
      if (!bucket) continue;
      for (const nodeId of bucket) {
        const node = railNetwork.nodes[nodeId];
        const projection = project(from, to, node);
        if (projection < -0.05 || projection > 1.05) continue;
        const perp = perpendicularDistanceKm(from, to, node);
        if (perp > Math.max(28, Math.min(110, directKm * 0.32))) continue;
        candidates.push({ lng: node.lng, lat: node.lat, projection, perpendicularKm: perp });
      }
    }
  }
  if (candidates.length < 5) return null;
  candidates.sort((a, b) => a.projection - b.projection);
  const sampled = sampleSpaced(candidates, directKm);
  if (sampled.length < 3) return null;
  const coords = [[from.lng, from.lat], ...sampled.map((point) => [point.lng, point.lat]), [to.lng, to.lat]];
  const cleaned = repairBigJumps(coords);
  if (cleaned.repaired) geometryStats.repairedJumps += 1;
  return {
    source: 'hotosm-rail-corridor',
    coordinates: cleaned.coordinates,
    distanceKm: polylineDistanceKm(cleaned.coordinates),
  };
}

function sampleSpaced(candidates, directKm) {
  const minSpacingKm = directKm > 400 ? 16 : directKm > 200 ? 9 : 4.5;
  const filtered = [];
  for (const point of candidates) {
    const previous = filtered[filtered.length - 1];
    if (!previous) {
      filtered.push(point);
      continue;
    }
    if (distance(previous, point) < minSpacingKm) continue;
    if (point.projection - previous.projection < 0.005) continue;
    filtered.push(point);
  }
  const maxPoints = directKm > 600 ? 60 : directKm > 260 ? 46 : 28;
  if (filtered.length <= maxPoints) return filtered;
  const sampled = [];
  for (let i = 0; i < maxPoints; i += 1) {
    sampled.push(filtered[Math.floor((i * (filtered.length - 1)) / (maxPoints - 1))]);
  }
  return sampled;
}

/**
 * Repair big jumps by inserting a straight-line interpolation across the gap.
 * If a single coordinate causes a jump from both sides, drop it. Returns
 * { coordinates, repaired } so the caller can record stats.
 */
function repairBigJumps(coordinates) {
  if (coordinates.length < 2) return { coordinates, repaired: false };
  const maxJumpDeg = 0.45;
  const cleaned = [coordinates[0]];
  let repaired = false;
  for (let i = 1; i < coordinates.length; i += 1) {
    const prev = cleaned[cleaned.length - 1];
    const curr = coordinates[i];
    const dlng = Math.abs(curr[0] - prev[0]);
    const dlat = Math.abs(curr[1] - prev[1]);
    if (dlng > maxJumpDeg || dlat > maxJumpDeg) {
      // If next coord is closer to prev, drop this outlier
      const next = coordinates[i + 1];
      if (next) {
        const nextDlng = Math.abs(next[0] - prev[0]);
        const nextDlat = Math.abs(next[1] - prev[1]);
        if (nextDlng < dlng && nextDlat < dlat) {
          repaired = true;
          continue;
        }
      }
      // Otherwise insert one or two intermediate points
      const steps = Math.ceil(Math.max(dlng, dlat) / maxJumpDeg);
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps;
        cleaned.push([prev[0] + (curr[0] - prev[0]) * t, prev[1] + (curr[1] - prev[1]) * t]);
      }
      cleaned.push(curr);
      repaired = true;
    } else {
      cleaned.push(curr);
    }
  }
  return { coordinates: cleaned, repaired };
}

function polylineDistanceKm(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += distance(
      { lng: coords[i - 1][0], lat: coords[i - 1][1] },
      { lng: coords[i][0], lat: coords[i][1] },
    );
  }
  return total;
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

// ============================================================================
// Helpers
// ============================================================================

function collectNameCandidates(props) {
  const names = new Set();
  const fields = ['name', 'name:zh', 'name:zh-Hans', 'name:zh-CN', 'official_name', 'short_name', 'alt_name'];
  for (const field of fields) {
    const value = props[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const trimmed = value.trim();
    names.add(trimmed);
    // Also add stripped 站 / 火车站 suffix variants
    const stripped = trimmed.replace(/(火车站|站|高铁站)$/u, '');
    if (stripped && stripped !== trimmed) names.add(stripped);
  }
  return [...names];
}

function inferProvinceCity(stations) {
  // Spatial nearest-neighbor inference: any OSM-augmented station inherits the
  // province/city of the nearest CSV-sourced station within 100km. This avoids
  // empty province cells in the corridor classification.
  const csvStations = stations.filter((station) => station.source === 'csv');
  const cellSize = 0.6;
  const cells = new Map();
  for (const station of csvStations) {
    const key = `${Math.floor(station.lng / cellSize)}:${Math.floor(station.lat / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(station);
  }
  for (const station of stations) {
    if (station.province && station.city) continue;
    let bestStation = null;
    let bestKm = 100;
    const cx = Math.floor(station.lng / cellSize);
    const cy = Math.floor(station.lat / cellSize);
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        const bucket = cells.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const candidate of bucket) {
          const km = distance(candidate, station);
          if (km < bestKm) {
            bestStation = candidate;
            bestKm = km;
          }
        }
      }
    }
    if (bestStation) {
      if (!station.province) station.province = bestStation.province;
      if (!station.city) station.city = bestStation.city;
    }
  }
}

function parseCsv(text) {
  const rows = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
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

function findSourceFileOptional(relativePaths) {
  for (const root of SOURCE_CANDIDATE_ROOTS) {
    for (const relativePath of relativePaths) {
      const candidate = path.join(root, relativePath);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function stationTier(station) {
  const name = station.name;
  const override = STATION_LOOKUP_TIER_OVERRIDES.get(name);
  if (override) return override;
  if (/北京|上海|广州|深圳|成都|重庆|武汉|郑州|西安|南京|杭州|长沙|天津|昆明|南宁|福州|厦门|哈尔滨|沈阳|大连|长春|济南|青岛|合肥|南昌|贵阳|乌鲁木齐|呼和浩特|银川|西宁|兰州|太原|石家庄/.test(name)) return 'national-hub';
  if ((station.sourceCount || 0) >= 4 || /南$|西$|东$|北$/.test(name)) return 'regional-hub';
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

function pct(part, total) {
  if (!total) return '0.0';
  return ((part / total) * 100).toFixed(1);
}

function roundCoordinates(coords) {
  // 5 decimals = ~1.1m precision at China latitudes — more than enough for HSR map render.
  return coords.map(([lng, lat]) => [
    Math.round(lng * 100000) / 100000,
    Math.round(lat * 100000) / 100000,
  ]);
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(PUBLIC, file), `${JSON.stringify(data)}\n`);
}
