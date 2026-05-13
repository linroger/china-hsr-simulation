import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

function createFixtureDatabase(dbPath) {
  const python = String.raw`
import json
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
conn.executescript("""
CREATE TABLE stations (
  station_code TEXT PRIMARY KEY,
  station_name TEXT NOT NULL,
  station_pinyin TEXT,
  city TEXT,
  station_id TEXT,
  station_short TEXT,
  code TEXT
);
CREATE TABLE train_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  train_no TEXT NOT NULL,
  train_code TEXT NOT NULL,
  depart_date TEXT NOT NULL,
  train_class_name TEXT,
  service_type TEXT,
  end_station_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(train_no, depart_date)
);
CREATE TABLE route_stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  train_route_id INTEGER NOT NULL,
  station_name TEXT NOT NULL,
  station_train_code TEXT,
  arrive_time TEXT,
  start_time TEXT,
  lishi TEXT,
  arrive_day_str TEXT,
  station_order INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  train_no TEXT,
  start_train_code TEXT,
  start_date TEXT,
  start_time TEXT,
  arrive_date TEXT,
  arrive_time TEXT,
  lishi TEXT,
  from_station TEXT,
  to_station TEXT,
  from_station_telecode TEXT,
  to_station_telecode TEXT,
  dw_flag TEXT,
  query_date TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE ticket_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  seat_name TEXT NOT NULL,
  seat_type_code TEXT,
  price REAL NOT NULL,
  num TEXT,
  discount INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE railway_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_id TEXT,
  name TEXT,
  name_en TEXT,
  railway_type TEXT,
  layer TEXT,
  geometry_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE station_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_code TEXT,
  station_name TEXT,
  osm_id TEXT,
  lon REAL,
  lat REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE station_track_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_code TEXT,
  track_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(station_code, track_id)
);
""")
conn.executemany(
    "INSERT INTO stations VALUES (?,?,?,?,?,?,?)",
    [
        ("AAA", "Alpha", "alpha", "A City", "1", "A", "AAA"),
        ("BBB", "Beta", "beta", "B City", "2", "B", "BBB"),
        ("CCC", "Gamma", "gamma", "C City", "3", "C", "CCC"),
    ],
)
conn.execute(
    "INSERT INTO train_routes VALUES (?,?,?,?,?,?,?,?)",
    (1, "G1", "G1", "2026-05-11", "高速", "1", "Gamma", "2026-05-11 00:00:00"),
)
conn.executemany(
    "INSERT INTO route_stations VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
        (1, 1, "Alpha", "G1", "08:00", "08:02", "00:00", "0", 1, "2026-05-11 00:00:00"),
        (2, 1, "Beta", "G1", "09:00", "09:02", "01:00", "0", 2, "2026-05-11 00:00:00"),
        (3, 1, "Gamma", "G1", "10:00", "10:02", "02:00", "0", 3, "2026-05-11 00:00:00"),
    ],
)
conn.execute(
    "INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (1, "G1", "G1", "2026-05-11", "08:02", "2026-05-11", "10:00", "02:00", "Alpha", "Gamma", "AAA", "CCC", "{}", "2026-05-10", "2026-05-10 00:00:00"),
)
conn.execute(
    "INSERT INTO ticket_prices VALUES (?,?,?,?,?,?,?,?)",
    (1, 1, "Second", "O", 120.5, "10", 0, "2026-05-10 00:00:00"),
)
conn.execute(
    "INSERT INTO railway_tracks VALUES (?,?,?,?,?,?,?,?)",
    (1, "osm-1", "Test Rail", "", "rail", "0", json.dumps({"type": "LineString", "coordinates": [[116.0, 39.0], [117.0, 40.0]]}), "2026-05-10 00:00:00"),
)
conn.executemany(
    "INSERT INTO station_locations VALUES (?,?,?,?,?,?,?)",
    [
        (1, "AAA", "Alpha", "osm-a", 116.0, 39.0, "2026-05-10 00:00:00"),
        (2, "BBB", "Beta", "osm-b", 116.5, 39.5, "2026-05-10 00:00:00"),
        (3, "CCC", "Gamma", "osm-c", 117.0, 40.0, "2026-05-10 00:00:00"),
    ],
)
conn.execute(
    "INSERT INTO station_track_links VALUES (?,?,?,?)",
    (1, "AAA", 1, "2026-05-10 00:00:00"),
)
conn.commit()
conn.close()
`;
  execFileSync('python3', ['-c', python, dbPath], { cwd: ROOT, stdio: 'pipe' });
}

test('12306 OceanBase migration dry-run emits review manifest and queryable route schema', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinahsr-12306-migration-'));
  const dbPath = path.join(tempDir, 'fixture.db');
  const outputDir = path.join(tempDir, 'out');
  try {
    createFixtureDatabase(dbPath);
    const output = execFileSync('python3', [
      'scripts/migrate_12306_to_oceanbase.py',
      '--sqlite',
      dbPath,
      '--output-dir',
      outputDir,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });

    assert.match(output, /\[12306:oceanbase\] dry-run complete/);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sqliteIntegrityCheck, 'ok');
    assert.equal(manifest.rowCounts.train_routes, 1);
    assert.equal(manifest.rowCounts.route_stations, 3);
    assert.equal(manifest.routeOrderQuality.routesWithoutStops, 0);
    assert.equal(manifest.routeOrderQuality.duplicateStationOrderRoutes, 0);
    assert.equal(manifest.routeStationNameMatching.unmatchedByStationName, 0);
    assert.equal(manifest.referentialQuality.ticketPricesOrphanTicket, 0);
    assert.equal(manifest.referentialQuality.ticketsFromCodeMissingStation, 0);
    assert.equal(manifest.railwayGeometry.parseErrors, 0);
    assert.equal(manifest.railwayGeometry.geometryTypes.LineString, 1);

    const schema = fs.readFileSync(path.join(outputDir, 'schema.sql'), 'utf8');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS `cr_12306_train_routes`/);
    assert.match(schema, /CREATE OR REPLACE VIEW `cr_12306_route_stop_sequences`/);
    assert.match(schema, /CREATE OR REPLACE VIEW `cr_12306_route_edges`/);
    assert.match(schema, /CREATE OR REPLACE VIEW `cr_12306_ticket_route_coverage`/);

    const sampleQueries = fs.readFileSync(path.join(outputDir, 'sample_queries.sql'), 'utf8');
    assert.match(sampleQueries, /ORDER BY stop_count DESC/);
    assert.match(sampleQueries, /WHERE train_route_id = \?/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('12306 simulation export preserves ordered stops and return route contract', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinahsr-12306-export-'));
  const dbPath = path.join(tempDir, 'fixture.db');
  try {
    createFixtureDatabase(dbPath);
    const output = execFileSync('python3', [
      'scripts/export_oceanbase_simulation_data.py',
      '--sqlite',
      dbPath,
      '--stdout',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });
    const payload = JSON.parse(output);
    assert.equal(payload.metadata.routeCount, 1);
    assert.equal(payload.metadata.stationCount, 3);
    assert.equal(payload.routes.length, 1);

    const route = payload.routes[0];
    assert.equal(route.code, 'G1');
    assert.deepEqual(route.stops.map((stop) => stop.name), ['Alpha', 'Beta', 'Gamma']);
    assert.deepEqual(route.routeContract.stopSequence, ['Alpha', 'Beta', 'Gamma']);
    assert.deepEqual(route.routeContract.returnStopSequence, ['Gamma', 'Beta', 'Alpha']);
    assert.equal(route.routeContract.outboundVariantId, `${route.id}:outbound`);
    assert.equal(route.routeContract.returnVariantId, `${route.id}:return`);
    assert.equal(route.segments.length, 2);
    assert.equal(route.segments[0].from, 'Alpha');
    assert.equal(route.segments[0].to, 'Beta');
    assert.deepEqual(route.segments[0].geometry[0], [116, 39]);
    assert.deepEqual(route.segments[1].geometry.at(-1), [117, 40]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
