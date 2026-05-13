#!/usr/bin/env python3
"""Review and migrate the local 12306 SQLite snapshot into OceanBase.

The source database is treated as an immutable input. By default this script
does not connect to OceanBase; it writes review metadata plus OceanBase DDL so
the migration can be inspected before a live load. Use --load when an
OceanBase MySQL-mode tenant is reachable through the OB_* environment
variables.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import statistics
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SQLITE = ROOT.parent / "12306.db"
DEFAULT_OUTPUT_DIR = ROOT / "exports" / "12306-oceanbase"
DEFAULT_TABLE_PREFIX = "cr_12306_"

TABLE_ORDER = [
    "stations",
    "train_routes",
    "route_stations",
    "tickets",
    "ticket_prices",
    "railway_tracks",
    "station_locations",
    "station_track_links",
]

TABLE_SPECS: dict[str, dict[str, Any]] = {
    "stations": {
        "primary_key": ["station_code"],
        "columns": ["station_code", "station_name", "station_pinyin", "city", "station_id", "station_short", "code"],
        "ddl": """
CREATE TABLE IF NOT EXISTS `{table}` (
  station_code VARCHAR(32) NOT NULL,
  station_name VARCHAR(128) NOT NULL,
  station_pinyin VARCHAR(160),
  city VARCHAR(128),
  station_id VARCHAR(64),
  station_short VARCHAR(64),
  code VARCHAR(32),
  PRIMARY KEY (station_code),
  KEY idx_station_name (station_name),
  KEY idx_station_city (city)
) DEFAULT CHARSET=utf8mb4
""",
    },
    "train_routes": {
        "primary_key": ["id"],
        "columns": [
            "id",
            "train_no",
            "train_code",
            "depart_date",
            "train_class_name",
            "service_type",
            "end_station_name",
            "created_at",
        ],
        "ddl": """
CREATE TABLE IF NOT EXISTS `{table}` (
  id BIGINT NOT NULL,
  train_no VARCHAR(64) NOT NULL,
  train_code VARCHAR(64) NOT NULL,
  depart_date DATE NOT NULL,
  train_class_name VARCHAR(64),
  service_type VARCHAR(16),
  end_station_name VARCHAR(128),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_train_departure (train_no, depart_date),
  KEY idx_train_code_departure (train_code, depart_date),
  KEY idx_train_class (train_class_name)
) DEFAULT CHARSET=utf8mb4
""",
    },
    "route_stations": {
        "primary_key": ["id"],
        "columns": [
            "id",
            "train_route_id",
            "station_name",
            "station_train_code",
            "arrive_time",
            "start_time",
            "lishi",
            "arrive_day_str",
            "station_order",
            "created_at",
        ],
        "ddl": """
CREATE TABLE IF NOT EXISTS `{table}` (
  id BIGINT NOT NULL,
  train_route_id BIGINT NOT NULL,
  station_name VARCHAR(128) NOT NULL,
  station_train_code VARCHAR(64),
  arrive_time VARCHAR(16),
  start_time VARCHAR(16),
  lishi VARCHAR(32),
  arrive_day_str VARCHAR(16),
  station_order INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_route_station_order (train_route_id, station_order),
  KEY idx_route_stations_train (train_route_id),
  KEY idx_route_stations_name (station_name),
  KEY idx_route_stations_code (station_train_code)
) DEFAULT CHARSET=utf8mb4
""",
    },
    "tickets": {
        "primary_key": ["id"],
        "columns": [
            "id",
            "train_no",
            "start_train_code",
            "start_date",
            "start_time",
            "arrive_date",
            "arrive_time",
            "lishi",
            "from_station",
            "to_station",
            "from_station_telecode",
            "to_station_telecode",
            "dw_flag",
            "query_date",
            "created_at",
        ],
        "ddl": """
CREATE TABLE IF NOT EXISTS `{table}` (
  id BIGINT NOT NULL,
  train_no VARCHAR(64),
  start_train_code VARCHAR(64),
  start_date DATE,
  start_time VARCHAR(16),
  arrive_date DATE,
  arrive_time VARCHAR(16),
  lishi VARCHAR(32),
  from_station VARCHAR(128),
  to_station VARCHAR(128),
  from_station_telecode VARCHAR(32),
  to_station_telecode VARCHAR(32),
  dw_flag LONGTEXT,
  query_date DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tickets_train (train_no, start_train_code),
  KEY idx_tickets_route (from_station_telecode, to_station_telecode, start_date),
  KEY idx_tickets_query_date (query_date)
) DEFAULT CHARSET=utf8mb4
""",
    },
    "ticket_prices": {
        "primary_key": ["id"],
        "columns": ["id", "ticket_id", "seat_name", "seat_type_code", "price", "num", "discount", "created_at"],
        "ddl": """
CREATE TABLE IF NOT EXISTS `{table}` (
  id BIGINT NOT NULL,
  ticket_id BIGINT NOT NULL,
  seat_name VARCHAR(64) NOT NULL,
  seat_type_code VARCHAR(16),
  price DECIMAL(10,2) NOT NULL,
  num VARCHAR(32),
  discount INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ticket_prices_ticket (ticket_id),
  KEY idx_ticket_prices_seat (seat_name, seat_type_code)
) DEFAULT CHARSET=utf8mb4
""",
    },
    "railway_tracks": {
        "primary_key": ["id"],
        "columns": ["id", "osm_id", "name", "name_en", "railway_type", "layer", "geometry_json", "created_at"],
        "ddl": """
CREATE TABLE IF NOT EXISTS `{table}` (
  id BIGINT NOT NULL,
  osm_id VARCHAR(96),
  name VARCHAR(255),
  name_en VARCHAR(255),
  railway_type VARCHAR(64),
  layer VARCHAR(32),
  geometry_json LONGTEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_railway_tracks_osm (osm_id),
  KEY idx_railway_tracks_name (name),
  KEY idx_railway_tracks_type (railway_type)
) DEFAULT CHARSET=utf8mb4
""",
    },
    "station_locations": {
        "primary_key": ["id"],
        "columns": ["id", "station_code", "station_name", "osm_id", "lon", "lat", "created_at"],
        "ddl": """
CREATE TABLE IF NOT EXISTS `{table}` (
  id BIGINT NOT NULL,
  station_code VARCHAR(32),
  station_name VARCHAR(128),
  osm_id VARCHAR(96),
  lon DOUBLE,
  lat DOUBLE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_station_locations_code (station_code),
  KEY idx_station_locations_name (station_name),
  KEY idx_station_locations_coord (lon, lat)
) DEFAULT CHARSET=utf8mb4
""",
    },
    "station_track_links": {
        "primary_key": ["id"],
        "columns": ["id", "station_code", "track_id", "created_at"],
        "ddl": """
CREATE TABLE IF NOT EXISTS `{table}` (
  id BIGINT NOT NULL,
  station_code VARCHAR(32),
  track_id BIGINT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_station_track (station_code, track_id),
  KEY idx_station_track_station (station_code),
  KEY idx_station_track_track (track_id)
) DEFAULT CHARSET=utf8mb4
""",
    },
}


def main() -> int:
    args = parse_args()
    started = time.perf_counter()
    table_prefix = validate_prefix(args.table_prefix)
    sqlite_path = Path(args.sqlite).expanduser().resolve()
    if not sqlite_path.exists():
        raise SystemExit(f"SQLite source not found: {sqlite_path}")

    conn = connect_sqlite(sqlite_path)
    try:
        assert_expected_tables(conn)
        review = analyze_source(conn, sqlite_path, skip_geometry_parse=args.skip_geometry_parse)
        ddl_statements = build_schema_statements(table_prefix)
        output_dir = Path(args.output_dir).expanduser().resolve()
        write_review_artifacts(output_dir, review, ddl_statements, table_prefix)

        load_result: dict[str, Any] | None = None
        if args.load:
            load_result = load_oceanbase(
                conn,
                table_prefix=table_prefix,
                ddl_statements=ddl_statements,
                truncate=args.truncate,
                batch_size=args.batch_size,
                create_database=args.create_database,
                allow_empty_password=args.allow_empty_password,
                row_limit=args.row_limit,
            )
            write_json(output_dir / "load-result.json", load_result)

        elapsed = round(time.perf_counter() - started, 3)
        mode = "loaded" if load_result else "dry-run"
        print(
            "[12306:oceanbase] "
            f"{mode} complete source={sqlite_path} tables={len(TABLE_ORDER)} "
            f"rows={review['totalRows']:,} output={output_dir} elapsed={elapsed}s"
        )
        if load_result:
            print("[12306:oceanbase] table counts " + json.dumps(load_result["targetRowCounts"], ensure_ascii=False))
    finally:
        conn.close()
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Review /Users/rogerlin/Downloads/chinashsr/12306.db and optionally load it into OceanBase."
    )
    parser.add_argument("--sqlite", default=str(DEFAULT_SQLITE), help="Path to the 12306 SQLite database.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Directory for schema.sql and manifest.json.")
    parser.add_argument("--table-prefix", default=DEFAULT_TABLE_PREFIX, help="Prefix for OceanBase target tables.")
    parser.add_argument("--batch-size", type=int, default=5000, help="Rows per OceanBase executemany batch.")
    parser.add_argument("--row-limit", type=int, default=0, help="Development-only limit per source table when --load is used.")
    parser.add_argument("--skip-geometry-parse", action="store_true", help="Skip GeoJSON parsing during the review pass.")
    parser.add_argument("--load", action="store_true", help="Connect to OceanBase and load the data.")
    parser.add_argument("--truncate", action="store_true", help="Truncate target tables before loading.")
    parser.add_argument("--create-database", action="store_true", help="Create OB_DATABASE if it does not exist.")
    parser.add_argument(
        "--allow-empty-password",
        action="store_true",
        help="Allow an empty OceanBase password for local OceanBase Desktop/SeekDB instances only.",
    )
    args = parser.parse_args()
    if args.batch_size < 100:
        parser.error("--batch-size must be at least 100")
    if args.row_limit < 0:
        parser.error("--row-limit cannot be negative")
    return args


def validate_prefix(prefix: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", prefix):
        raise SystemExit("--table-prefix must be a simple SQL identifier prefix")
    return prefix


def connect_sqlite(path: Path) -> sqlite3.Connection:
    uri = f"{path.as_uri()}?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def assert_expected_tables(conn: sqlite3.Connection) -> None:
    found = {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    missing = [table for table in TABLE_ORDER if table not in found]
    if missing:
        raise SystemExit(f"SQLite source is missing required table(s): {', '.join(missing)}")


def analyze_source(conn: sqlite3.Connection, sqlite_path: Path, *, skip_geometry_parse: bool) -> dict[str, Any]:
    row_counts = {table: int(scalar(conn, f"SELECT COUNT(*) FROM {quote_sqlite(table)}")) for table in TABLE_ORDER}
    table_schema = {table: pragma_table_info(conn, table) for table in TABLE_ORDER}
    date_ranges = {
        "train_routes.depart_date": date_range(conn, "train_routes", "depart_date"),
        "tickets.query_date": date_range(conn, "tickets", "query_date"),
        "tickets.start_date": date_range(conn, "tickets", "start_date"),
    }
    route_stop_counts = [
        int(row["stop_count"])
        for row in conn.execute(
            "SELECT COUNT(*) AS stop_count FROM route_stations GROUP BY train_route_id ORDER BY stop_count"
        )
    ]
    route_order_quality = {
        "routesWithoutStops": int(
            scalar(
                conn,
                """
                SELECT COUNT(*)
                FROM train_routes tr
                LEFT JOIN route_stations rs ON rs.train_route_id = tr.id
                WHERE rs.id IS NULL
                """,
            )
        ),
        "duplicateStationOrderRoutes": int(
            scalar(
                conn,
                """
                SELECT COUNT(DISTINCT train_route_id)
                FROM (
                  SELECT train_route_id, station_order, COUNT(*) AS c
                  FROM route_stations
                  GROUP BY train_route_id, station_order
                  HAVING c > 1
                ) dup
                """,
            )
        ),
        "nonOneStartRoutes": int(
            scalar(
                conn,
                """
                SELECT COUNT(*)
                FROM (
                  SELECT train_route_id, MIN(station_order) AS min_order
                  FROM route_stations
                  GROUP BY train_route_id
                ) q
                WHERE min_order <> 1
                """,
            )
        ),
        "gapRoutes": int(
            scalar(
                conn,
                """
                SELECT COUNT(*)
                FROM (
                  SELECT train_route_id, COUNT(*) AS c, MAX(station_order) AS max_order
                  FROM route_stations
                  GROUP BY train_route_id
                ) q
                WHERE c <> max_order
                """,
            )
        ),
    }
    referential_quality = {
        "ticketPricesOrphanTicket": count_left_join_misses(conn, "ticket_prices", "tickets", "ticket_id", "id"),
        "stationLocationsOrphanStationCode": count_left_join_misses(
            conn, "station_locations", "stations", "station_code", "station_code"
        ),
        "stationTrackLinksOrphanStationCode": count_left_join_misses(
            conn, "station_track_links", "stations", "station_code", "station_code"
        ),
        "stationTrackLinksOrphanTrackId": count_left_join_misses(
            conn, "station_track_links", "railway_tracks", "track_id", "id"
        ),
        "ticketsFromCodeMissingStation": int(
            scalar(
                conn,
                """
                SELECT COUNT(*)
                FROM tickets t
                LEFT JOIN stations s ON s.station_code = t.from_station_telecode
                WHERE s.station_code IS NULL
                """,
            )
        ),
        "ticketsToCodeMissingStation": int(
            scalar(
                conn,
                """
                SELECT COUNT(*)
                FROM tickets t
                LEFT JOIN stations s ON s.station_code = t.to_station_telecode
                WHERE s.station_code IS NULL
                """,
            )
        ),
        "trainRoutesWithoutTicketSameTrainNo": int(
            scalar(
                conn,
                """
                SELECT COUNT(*)
                FROM train_routes tr
                LEFT JOIN tickets t ON t.train_no = tr.train_no
                WHERE t.id IS NULL
                """,
            )
        ),
        "ticketsWithoutTrainRouteSameTrainNo": int(
            scalar(
                conn,
                """
                SELECT COUNT(*)
                FROM tickets t
                LEFT JOIN train_routes tr ON tr.train_no = t.train_no
                WHERE tr.id IS NULL
                """,
            )
        ),
    }
    station_location_quality = {
        "totalLocations": row_counts["station_locations"],
        "distinctStationCodesWithLocation": int(
            scalar(conn, "SELECT COUNT(DISTINCT station_code) FROM station_locations WHERE station_code IS NOT NULL")
        ),
        "plausibleChinaCoordinates": int(
            scalar(
                conn,
                """
                SELECT COUNT(*)
                FROM station_locations
                WHERE lon BETWEEN 70 AND 140 AND lat BETWEEN 15 AND 55
                """,
            )
        ),
        "stationsWithLocation": int(
            scalar(
                conn,
                """
                SELECT COUNT(DISTINCT s.station_code)
                FROM stations s
                JOIN station_locations sl ON sl.station_code = s.station_code
                """,
            )
        ),
        "stationsTotal": row_counts["stations"],
    }

    geometry = {"skipped": True}
    if not skip_geometry_parse:
        geometry = analyze_track_geometry(conn)

    review = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sourcePath": str(sqlite_path),
        "sourceBytes": sqlite_path.stat().st_size,
        "sqliteIntegrityCheck": scalar(conn, "PRAGMA integrity_check"),
        "sqlitePageSize": scalar(conn, "PRAGMA page_size"),
        "sqlitePageCount": scalar(conn, "PRAGMA page_count"),
        "tables": table_schema,
        "rowCounts": row_counts,
        "totalRows": sum(row_counts.values()),
        "dateRanges": date_ranges,
        "trainClassCounts": grouped_counts(conn, "train_routes", ["train_class_name", "service_type"], limit=20),
        "routeStopStats": summarize_numbers(route_stop_counts),
        "longestRoutes": rows_as_dicts(
            conn,
            """
            SELECT tr.train_no, tr.train_code, tr.depart_date, tr.train_class_name,
                   MAX(CASE WHEN rs.station_order = 1 THEN rs.station_name END) AS first_station,
                   tr.end_station_name,
                   COUNT(*) AS stop_count
            FROM train_routes tr
            JOIN route_stations rs ON rs.train_route_id = tr.id
            GROUP BY tr.id
            ORDER BY stop_count DESC, tr.train_no
            LIMIT 12
            """,
        ),
        "routeOrderQuality": route_order_quality,
        "referentialQuality": referential_quality,
        "routeStationNameMatching": {
            "distinctRouteStationNames": int(scalar(conn, "SELECT COUNT(DISTINCT station_name) FROM route_stations")),
            "unmatchedByStationName": int(
                scalar(
                    conn,
                    """
                    SELECT COUNT(*)
                    FROM (
                      SELECT DISTINCT rs.station_name
                      FROM route_stations rs
                      LEFT JOIN stations s ON s.station_name = rs.station_name
                      WHERE s.station_code IS NULL
                    ) q
                    """,
                )
            ),
        },
        "topTicketOriginsDestinations": rows_as_dicts(
            conn,
            """
            SELECT from_station, to_station, COUNT(*) AS ticket_count
            FROM tickets
            GROUP BY from_station, to_station
            ORDER BY ticket_count DESC, from_station, to_station
            LIMIT 20
            """,
        ),
        "ticketPriceStats": rows_as_dicts(
            conn,
            """
            SELECT seat_name, seat_type_code, COUNT(*) AS price_rows,
                   MIN(price) AS min_price, ROUND(AVG(price), 2) AS avg_price,
                   MAX(price) AS max_price,
                   SUM(CASE WHEN num IS NOT NULL AND num <> '' AND num <> '无' THEN 1 ELSE 0 END) AS rows_with_availability
            FROM ticket_prices
            GROUP BY seat_name, seat_type_code
            ORDER BY price_rows DESC
            LIMIT 20
            """,
        ),
        "stationLocationQuality": station_location_quality,
        "topRailwayTrackNames": rows_as_dicts(
            conn,
            """
            SELECT COALESCE(NULLIF(name, ''), '(blank)') AS name, COUNT(*) AS segment_count
            FROM railway_tracks
            GROUP BY COALESCE(NULLIF(name, ''), '(blank)')
            ORDER BY segment_count DESC, name
            LIMIT 20
            """,
        ),
        "railwayGeometry": geometry,
    }
    return review


def analyze_track_geometry(conn: sqlite3.Connection) -> dict[str, Any]:
    type_counts: Counter[str] = Counter()
    point_counts: list[int] = []
    parse_errors = 0
    min_lng = min_lat = float("inf")
    max_lng = max_lat = float("-inf")
    for row in conn.execute("SELECT geometry_json FROM railway_tracks"):
        try:
            geometry = json.loads(row["geometry_json"])
            geometry_type = str(geometry.get("type") or "unknown")
            coords = geometry.get("coordinates") or []
        except (json.JSONDecodeError, TypeError, AttributeError):
            parse_errors += 1
            continue
        type_counts[geometry_type] += 1
        if geometry_type == "LineString" and isinstance(coords, list):
            point_counts.append(len(coords))
            for coord in coords:
                if isinstance(coord, (list, tuple)) and len(coord) >= 2:
                    lng = as_float(coord[0])
                    lat = as_float(coord[1])
                    if lng is None or lat is None:
                        continue
                    min_lng = min(min_lng, lng)
                    max_lng = max(max_lng, lng)
                    min_lat = min(min_lat, lat)
                    max_lat = max(max_lat, lat)
    coord_range = None
    if min_lng != float("inf"):
        coord_range = {
            "minLng": round(min_lng, 6),
            "maxLng": round(max_lng, 6),
            "minLat": round(min_lat, 6),
            "maxLat": round(max_lat, 6),
        }
    return {
        "skipped": False,
        "parseErrors": parse_errors,
        "geometryTypes": dict(type_counts),
        "pointsPerGeometry": summarize_numbers(point_counts),
        "coordinateRange": coord_range,
    }


def build_schema_statements(prefix: str) -> list[str]:
    statements = []
    for source_table in TABLE_ORDER:
        target_table = target_name(prefix, source_table)
        statements.append(TABLE_SPECS[source_table]["ddl"].format(table=target_table).strip())
    statements.extend(build_view_statements(prefix))
    return statements


def build_view_statements(prefix: str) -> list[str]:
    train_routes = target_name(prefix, "train_routes")
    route_stations = target_name(prefix, "route_stations")
    tickets = target_name(prefix, "tickets")
    view_sequences = target_name(prefix, "route_stop_sequences")
    view_edges = target_name(prefix, "route_edges")
    view_ticket_routes = target_name(prefix, "ticket_route_coverage")
    return [
        f"""
CREATE OR REPLACE VIEW `{view_sequences}` AS
SELECT
  tr.id AS train_route_id,
  tr.train_no,
  tr.train_code,
  tr.depart_date,
  tr.train_class_name,
  tr.service_type,
  MAX(CASE WHEN rs.station_order = 1 THEN rs.station_name END) AS origin_station,
  MAX(CASE WHEN rs.station_order = mx.max_order THEN rs.station_name END) AS terminal_station,
  COUNT(*) AS stop_count,
  GROUP_CONCAT(rs.station_name ORDER BY rs.station_order SEPARATOR ' -> ') AS stop_sequence
FROM `{train_routes}` tr
JOIN `{route_stations}` rs ON rs.train_route_id = tr.id
JOIN (
  SELECT train_route_id, MAX(station_order) AS max_order
  FROM `{route_stations}`
  GROUP BY train_route_id
) mx ON mx.train_route_id = tr.id
GROUP BY tr.id, tr.train_no, tr.train_code, tr.depart_date, tr.train_class_name, tr.service_type
""".strip(),
        f"""
CREATE OR REPLACE VIEW `{view_edges}` AS
SELECT
  cur.train_route_id,
  cur.station_order AS from_order,
  nxt.station_order AS to_order,
  cur.station_name AS from_station,
  nxt.station_name AS to_station,
  cur.start_time AS from_departure_time,
  nxt.arrive_time AS to_arrival_time
FROM `{route_stations}` cur
JOIN `{route_stations}` nxt
  ON nxt.train_route_id = cur.train_route_id
 AND nxt.station_order = cur.station_order + 1
""".strip(),
        f"""
CREATE OR REPLACE VIEW `{view_ticket_routes}` AS
SELECT
  t.id AS ticket_id,
  t.train_no,
  t.start_train_code,
  t.from_station,
  t.to_station,
  t.from_station_telecode,
  t.to_station_telecode,
  t.start_date,
  tr.id AS train_route_id,
  tr.depart_date,
  tr.train_class_name
FROM `{tickets}` t
LEFT JOIN `{train_routes}` tr
  ON tr.train_no = t.train_no
""".strip(),
    ]


def write_review_artifacts(output_dir: Path, review: dict[str, Any], statements: list[str], table_prefix: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    write_json(output_dir / "manifest.json", review)
    schema_sql = ";\n\n".join(statements) + ";\n"
    (output_dir / "schema.sql").write_text(schema_sql, encoding="utf-8")
    (output_dir / "sample_queries.sql").write_text(build_sample_queries(table_prefix), encoding="utf-8")


def build_sample_queries(prefix: str) -> str:
    sequences = target_name(prefix, "route_stop_sequences")
    edges = target_name(prefix, "route_edges")
    tickets = target_name(prefix, "ticket_route_coverage")
    return f"""-- Longest stop-by-stop routes.
SELECT train_no, train_code, depart_date, origin_station, terminal_station, stop_count, stop_sequence
FROM `{sequences}`
ORDER BY stop_count DESC
LIMIT 20;

-- Ordered station-to-station edges for one train route.
SELECT train_route_id, from_order, to_order, from_station, to_station
FROM `{edges}`
WHERE train_route_id = ?
ORDER BY from_order;

-- Ticket rows that do not currently have a matching route by train_no.
SELECT *
FROM `{tickets}`
WHERE train_route_id IS NULL
LIMIT 50;
"""


def load_oceanbase(
    sqlite_conn: sqlite3.Connection,
    *,
    table_prefix: str,
    ddl_statements: list[str],
    truncate: bool,
    batch_size: int,
    create_database: bool,
    allow_empty_password: bool,
    row_limit: int,
) -> dict[str, Any]:
    ob_conn = connect_oceanbase(create_database=create_database, allow_empty_password=allow_empty_password)
    started = time.perf_counter()
    try:
        with ob_conn.cursor() as cursor:
            for statement in ddl_statements:
                cursor.execute(statement)
        # DDL causes implicit commit in MySQL/OceanBase; data loading is all-or-nothing below.

        if truncate:
            with ob_conn.cursor() as cursor:
                for source_table in reversed(TABLE_ORDER):
                    cursor.execute(f"TRUNCATE TABLE `{target_name(table_prefix, source_table)}`")

        loaded_counts: dict[str, int] = {}
        for source_table in TABLE_ORDER:
            loaded_counts[source_table] = load_one_table(
                sqlite_conn,
                ob_conn,
                source_table=source_table,
                target_table=target_name(table_prefix, source_table),
                batch_size=batch_size,
                row_limit=row_limit,
            )
            print(f"[12306:oceanbase] loaded {source_table}: {loaded_counts[source_table]:,}", flush=True)

        with ob_conn.cursor() as cursor:
            for statement in build_view_statements(table_prefix):
                cursor.execute(statement)
        ob_conn.commit()
        target_counts = query_target_counts(ob_conn, table_prefix)
        return {
            "loadedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "elapsedSeconds": round(time.perf_counter() - started, 3),
            "sourceLoadedCounts": loaded_counts,
            "targetRowCounts": target_counts,
        }
    finally:
        ob_conn.close()


def connect_oceanbase(*, create_database: bool, allow_empty_password: bool):
    try:
        import pymysql
    except ImportError as exc:
        raise SystemExit("PyMySQL is required for --load. Install it with python3 -m pip install PyMySQL.") from exc

    password = os.environ.get("OB_PASSWORD", "")
    if not password and not allow_empty_password:
        raise SystemExit(
            "OB_PASSWORD is required for --load. For a local OceanBase Desktop tenant that intentionally has "
            "an empty root password, rerun with --allow-empty-password."
        )

    host = os.environ.get("OB_HOST", "127.0.0.1")
    port = int(os.environ.get("OB_PORT", "2881"))
    user = os.environ.get("OB_USER", "root")
    database = os.environ.get("OB_DATABASE", "chinahsr")
    try:
        conn = pymysql.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database=None if create_database else database,
            charset="utf8mb4",
            autocommit=False,
            connect_timeout=8,
        )
        if create_database:
            with conn.cursor() as cursor:
                cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{validate_identifier(database)}` DEFAULT CHARSET=utf8mb4")
            conn.select_db(database)
        return conn
    except pymysql.err.OperationalError as exc:
        raise SystemExit(
            f"Unable to connect to OceanBase at {host}:{port} database={database}. "
            "Verify the CVM tunnel/security group/tenant, OB_HOST, OB_PORT, OB_DATABASE, and OB_USER. "
            f"Driver error: {exc.args[0] if exc.args else exc}"
        ) from None


def load_one_table(
    sqlite_conn: sqlite3.Connection,
    ob_conn: Any,
    *,
    source_table: str,
    target_table: str,
    batch_size: int,
    row_limit: int,
) -> int:
    spec = TABLE_SPECS[source_table]
    columns = spec["columns"]
    select_cols = ", ".join(quote_sqlite(col) for col in columns)
    limit_clause = f" LIMIT {row_limit}" if row_limit else ""
    source_cursor = sqlite_conn.execute(f"SELECT {select_cols} FROM {quote_sqlite(source_table)}{limit_clause}")
    insert_sql = build_upsert_sql(target_table, columns, spec["primary_key"])
    total = 0
    while True:
        batch = source_cursor.fetchmany(batch_size)
        if not batch:
            break
        values = [tuple(row[col] for col in columns) for row in batch]
        with ob_conn.cursor() as cursor:
            cursor.executemany(insert_sql, values)
        total += len(values)
    return total


def build_upsert_sql(target_table: str, columns: list[str], primary_key: list[str]) -> str:
    quoted_cols = ", ".join(f"`{col}`" for col in columns)
    placeholders = ", ".join(["%s"] * len(columns))
    update_cols = [col for col in columns if col not in primary_key]
    if not update_cols:
        update_cols = columns[:1]
    updates = ", ".join(f"`{col}`=VALUES(`{col}`)" for col in update_cols)
    return f"INSERT INTO `{target_table}` ({quoted_cols}) VALUES ({placeholders}) ON DUPLICATE KEY UPDATE {updates}"


def query_target_counts(conn: Any, table_prefix: str) -> dict[str, int]:
    counts = {}
    with conn.cursor() as cursor:
        for source_table in TABLE_ORDER:
            cursor.execute(f"SELECT COUNT(*) FROM `{target_name(table_prefix, source_table)}`")
            counts[source_table] = int(cursor.fetchone()[0])
    return counts


def scalar(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> Any:
    row = conn.execute(sql, params).fetchone()
    return row[0] if row else None


def rows_as_dicts(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def pragma_table_info(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    return rows_as_dicts(conn, f"PRAGMA table_info({quote_sqlite(table)})")


def date_range(conn: sqlite3.Connection, table: str, column: str) -> dict[str, Any]:
    row = conn.execute(
        f"""
        SELECT MIN({quote_sqlite(column)}) AS min_value,
               MAX({quote_sqlite(column)}) AS max_value,
               COUNT(DISTINCT {quote_sqlite(column)}) AS distinct_count
        FROM {quote_sqlite(table)}
        WHERE {quote_sqlite(column)} IS NOT NULL AND {quote_sqlite(column)} <> ''
        """
    ).fetchone()
    return dict(row) if row else {"min_value": None, "max_value": None, "distinct_count": 0}


def count_left_join_misses(
    conn: sqlite3.Connection,
    left_table: str,
    right_table: str,
    left_column: str,
    right_column: str,
) -> int:
    return int(
        scalar(
            conn,
            f"""
            SELECT COUNT(*)
            FROM {quote_sqlite(left_table)} l
            LEFT JOIN {quote_sqlite(right_table)} r
              ON r.{quote_sqlite(right_column)} = l.{quote_sqlite(left_column)}
            WHERE l.{quote_sqlite(left_column)} IS NOT NULL
              AND r.{quote_sqlite(right_column)} IS NULL
            """,
        )
    )


def grouped_counts(conn: sqlite3.Connection, table: str, columns: list[str], *, limit: int) -> list[dict[str, Any]]:
    grouped = ", ".join(quote_sqlite(column) for column in columns)
    return rows_as_dicts(
        conn,
        f"""
        SELECT {grouped}, COUNT(*) AS row_count
        FROM {quote_sqlite(table)}
        GROUP BY {grouped}
        ORDER BY row_count DESC
        LIMIT {limit}
        """,
    )


def summarize_numbers(values: list[int]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "min": None, "p25": None, "median": None, "p75": None, "p95": None, "max": None, "avg": None}
    ordered = sorted(values)
    return {
        "count": len(values),
        "min": ordered[0],
        "p25": percentile(ordered, 0.25),
        "median": statistics.median(ordered),
        "p75": percentile(ordered, 0.75),
        "p95": percentile(ordered, 0.95),
        "max": ordered[-1],
        "avg": round(sum(values) / len(values), 2),
    }


def percentile(ordered_values: list[int], fraction: float) -> float:
    if len(ordered_values) == 1:
        return float(ordered_values[0])
    index = (len(ordered_values) - 1) * fraction
    lower = int(index)
    upper = min(lower + 1, len(ordered_values) - 1)
    weight = index - lower
    return round(ordered_values[lower] * (1 - weight) + ordered_values[upper] * weight, 2)


def as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def quote_sqlite(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def target_name(prefix: str, source_table: str) -> str:
    return validate_identifier(prefix + source_table)


def validate_identifier(identifier: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", identifier):
        raise SystemExit(f"Unsafe SQL identifier: {identifier}")
    return identifier


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
