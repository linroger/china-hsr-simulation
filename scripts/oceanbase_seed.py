#!/usr/bin/env python3
"""Seed OceanBase with a full-year China HSR service simulation.

The browser engine keeps detailed seat calendars for the rolling active day.
This script computes the 365-day route-service fact table that is too large
and too durable to belong in the browser heap.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from multiprocessing import get_context
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
TRAIN_SEAT_QUOTA = 554
MIN_DAILY_TRAINS_PER_ROUTE = 2
BASE_SECOND_CLASS_YUAN_PER_KM = 0.46
DEFAULT_START_DATE = "2026-01-01"
DEFAULT_DAYS = 365
DEFAULT_SUMMARY_PATH = PUBLIC / "oceanbase-yearly-summary.json"

WORKER_ROUTES: list[dict[str, Any]] = []


def log(message: str) -> None:
    print(f"[oceanbase:seed] {message}", flush=True)


SCHEMA_SQL = [
    """
    CREATE TABLE IF NOT EXISTS stations (
      station_id VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      province VARCHAR(64),
      city VARCHAR(64),
      bureau VARCHAR(128),
      kind VARCHAR(64),
      tier VARCHAR(32),
      lng DOUBLE,
      lat DOUBLE,
      source_count INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (station_id),
      KEY idx_stations_name (name),
      KEY idx_stations_province (province)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS routes (
      route_id VARCHAR(160) NOT NULL,
      code VARCHAR(64),
      train_no VARCHAR(64),
      route_type VARCHAR(8),
      origin VARCHAR(128),
      destination VARCHAR(128),
      origin_province VARCHAR(64),
      destination_province VARCHAR(64),
      corridor VARCHAR(128),
      total_distance_km DOUBLE,
      frequency_rank DOUBLE,
      stop_count INT,
      segment_count INT,
      provenance VARCHAR(255),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (route_id),
      KEY idx_routes_corridor (corridor),
      KEY idx_routes_origin (origin),
      KEY idx_routes_destination (destination)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS route_stops (
      route_id VARCHAR(160) NOT NULL,
      stop_index INT NOT NULL,
      station_id VARCHAR(64),
      name VARCHAR(128),
      province VARCHAR(64),
      city VARCHAR(64),
      tier VARCHAR(32),
      lng DOUBLE,
      lat DOUBLE,
      dwell_minutes INT,
      simulated_stop TINYINT DEFAULT 0,
      PRIMARY KEY (route_id, stop_index),
      KEY idx_route_stops_station (station_id)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS route_segments (
      route_id VARCHAR(160) NOT NULL,
      segment_index INT NOT NULL,
      from_station VARCHAR(128),
      to_station VARCHAR(128),
      distance_km DOUBLE,
      speed_limit_kmh INT,
      track_type VARCHAR(32),
      signaling VARCHAR(64),
      geometry_source VARCHAR(64),
      geometry_point_count INT,
      PRIMARY KEY (route_id, segment_index),
      KEY idx_route_segments_from_to (from_station, to_station)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS simulation_runs (
      run_id VARCHAR(96) NOT NULL,
      generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      start_date DATE,
      end_date DATE,
      days INT,
      route_count INT,
      station_count INT,
      worker_count INT,
      chunk_days INT,
      total_route_day_rows BIGINT,
      total_train_services BIGINT,
      estimated_passengers BIGINT,
      estimated_revenue DECIMAL(24,2),
      surge_day_count INT,
      generated_seconds DOUBLE,
      summary_json_path VARCHAR(255),
      PRIMARY KEY (run_id),
      KEY idx_simulation_runs_generated_at (generated_at)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS daily_route_services (
      run_id VARCHAR(96) NOT NULL,
      service_date DATE NOT NULL,
      day_index INT NOT NULL,
      route_id VARCHAR(160) NOT NULL,
      service_count INT NOT NULL,
      demand_multiplier DECIMAL(8,3),
      capacity_multiplier DECIMAL(8,3),
      price_surge_multiplier DECIMAL(8,3),
      estimated_passengers BIGINT,
      estimated_revenue DECIMAL(24,2),
      is_weekend TINYINT DEFAULT 0,
      is_holiday TINYINT DEFAULT 0,
      calendar_label VARCHAR(128),
      PRIMARY KEY (run_id, day_index, route_id),
      KEY idx_daily_route_services_date (service_date),
      KEY idx_daily_route_services_route_date (route_id, service_date)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS route_geometry (
      route_id VARCHAR(160) NOT NULL,
      segment_index INT NOT NULL,
      geometry_source VARCHAR(64),
      coordinate_count INT,
      coordinates_json LONGTEXT,
      PRIMARY KEY (route_id, segment_index)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS route_variants (
      route_variant_id VARCHAR(192) NOT NULL,
      route_id VARCHAR(160) NOT NULL,
      direction VARCHAR(16) NOT NULL,
      origin VARCHAR(128),
      destination VARCHAR(128),
      origin_province VARCHAR(64),
      destination_province VARCHAR(64),
      stop_count INT,
      segment_count INT,
      total_distance_km DOUBLE,
      stop_sequence_hash VARCHAR(64),
      stop_sequence_json LONGTEXT,
      provenance VARCHAR(255),
      is_active TINYINT DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (route_variant_id),
      KEY idx_route_variants_route (route_id),
      KEY idx_route_variants_direction (direction),
      KEY idx_route_variants_origin_dest (origin, destination)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS route_variant_stops (
      route_variant_id VARCHAR(192) NOT NULL,
      route_id VARCHAR(160) NOT NULL,
      direction VARCHAR(16) NOT NULL,
      stop_index INT NOT NULL,
      station_id VARCHAR(64),
      name VARCHAR(128),
      province VARCHAR(64),
      city VARCHAR(64),
      tier VARCHAR(32),
      lng DOUBLE,
      lat DOUBLE,
      dwell_minutes INT,
      simulated_stop TINYINT DEFAULT 0,
      PRIMARY KEY (route_variant_id, stop_index),
      KEY idx_route_variant_stops_route (route_id),
      KEY idx_route_variant_stops_station (station_id),
      KEY idx_route_variant_stops_direction (direction)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS route_variant_segments (
      route_variant_id VARCHAR(192) NOT NULL,
      route_id VARCHAR(160) NOT NULL,
      direction VARCHAR(16) NOT NULL,
      segment_index INT NOT NULL,
      from_station VARCHAR(128),
      to_station VARCHAR(128),
      distance_km DOUBLE,
      speed_limit_kmh INT,
      track_type VARCHAR(32),
      signaling VARCHAR(64),
      geometry_source VARCHAR(64),
      geometry_point_count INT,
      PRIMARY KEY (route_variant_id, segment_index),
      KEY idx_route_variant_segments_route (route_id),
      KEY idx_route_variant_segments_from_to (from_station, to_station)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS route_variant_geometry (
      route_variant_id VARCHAR(192) NOT NULL,
      route_id VARCHAR(160) NOT NULL,
      direction VARCHAR(16) NOT NULL,
      segment_index INT NOT NULL,
      geometry_source VARCHAR(64),
      coordinate_count INT,
      coordinates_json LONGTEXT,
      PRIMARY KEY (route_variant_id, segment_index),
      KEY idx_route_variant_geometry_route (route_id)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS rail_tracks (
      rail_track_id VARCHAR(192) NOT NULL,
      osm_id VARCHAR(64),
      name VARCHAR(255),
      gauge VARCHAR(64),
      electrified VARCHAR(64),
      usage_type VARCHAR(64),
      hsr TINYINT DEFAULT 0,
      coordinate_count INT,
      properties_json LONGTEXT,
      geometry_json LONGTEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (rail_track_id),
      KEY idx_rail_tracks_osm (osm_id),
      KEY idx_rail_tracks_name (name)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS calendar_summary (
      run_id VARCHAR(96) NOT NULL,
      service_date DATE NOT NULL,
      day_index INT NOT NULL,
      day_of_week INT,
      is_weekend TINYINT DEFAULT 0,
      is_holiday TINYINT DEFAULT 0,
      calendar_label VARCHAR(128),
      demand_multiplier DECIMAL(8,3),
      capacity_multiplier DECIMAL(8,3),
      price_surge_multiplier DECIMAL(8,3),
      total_train_services BIGINT,
      total_passengers BIGINT,
      total_revenue DECIMAL(24,2),
      PRIMARY KEY (run_id, day_index),
      KEY idx_calendar_summary_label (calendar_label),
      KEY idx_calendar_summary_date (service_date)
    ) DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS bookings (
      ticket_id VARCHAR(64) NOT NULL,
      run_id VARCHAR(96),
      train_id VARCHAR(160),
      train_code VARCHAR(64),
      route_id VARCHAR(160),
      passenger_id VARCHAR(64),
      passenger_name VARCHAR(128),
      origin_station VARCHAR(128),
      destination_station VARCHAR(128),
      origin_index INT,
      destination_index INT,
      seat_class VARCHAR(32),
      seat_count INT,
      seats_json VARCHAR(512),
      price DECIMAL(12,2),
      distance_km INT,
      booked_at_minute INT,
      booked_at_clock VARCHAR(8),
      service_date DATE,
      status VARCHAR(32),
      no_show TINYINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (ticket_id),
      KEY idx_bookings_train (train_id),
      KEY idx_bookings_route_date (route_id, service_date),
      KEY idx_bookings_status (status),
      KEY idx_bookings_run (run_id)
    ) DEFAULT CHARSET=utf8mb4
    """,
]


def main() -> int:
    args = parse_args()
    start = time.perf_counter()
    start_date = date.fromisoformat(args.start_date)
    route_data = read_json(PUBLIC / "route-data.json")
    station_data = read_json(PUBLIC / "station-data.json")
    rail_data = read_json(PUBLIC / "hsr-rails.geojson") if (PUBLIC / "hsr-rails.geojson").exists() else {"features": []}
    routes = route_data.get("routes", [])
    stations = station_data.get("stations", [])
    rail_features = rail_data.get("features", [])
    if not routes:
        raise SystemExit("No routes found in public/route-data.json. Run npm run prepare:data first.")
    if not stations:
        raise SystemExit("No stations found in public/station-data.json. Run npm run prepare:data first.")

    run_id = args.run_id or f"yearly-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    summary_path = Path(args.summary_path).resolve()
    summary_path.parent.mkdir(parents=True, exist_ok=True)

    log(f"run={run_id} days={args.days} routes={len(routes)} workers={args.workers} chunk_days={args.chunk_days}")

    conn = None
    if not args.skip_db:
        log(f"connecting to OceanBase at {os.environ.get('OB_HOST', '127.0.0.1')}:{os.environ.get('OB_PORT', '2881')}")
        conn = connect_oceanbase(read_db_config())
        with conn.cursor() as cursor:
            for statement in SCHEMA_SQL:
                cursor.execute(statement)
        conn.commit()
        log(f"loading dimension tables: {len(stations):,} stations, {len(routes):,} routes")
        load_static_dimension_tables(conn, stations, routes, args.batch_size)
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM daily_route_services WHERE run_id = %s", (run_id,))
            cursor.execute("DELETE FROM route_geometry WHERE route_id IN (SELECT route_id FROM routes)")
            cursor.execute("DELETE FROM route_variants WHERE route_id IN (SELECT route_id FROM routes)")
            cursor.execute("DELETE FROM route_variant_stops WHERE route_id IN (SELECT route_id FROM routes)")
            cursor.execute("DELETE FROM route_variant_segments WHERE route_id IN (SELECT route_id FROM routes)")
            cursor.execute("DELETE FROM route_variant_geometry WHERE route_id IN (SELECT route_id FROM routes)")
        conn.commit()
        load_route_geometry(conn, routes, args.batch_size)
        load_route_variants(conn, routes, args.batch_size)
        if rail_features:
            load_rail_tracks(conn, rail_features, args.batch_size)

    totals = generate_and_optionally_insert_daily_rows(
        run_id=run_id,
        routes=routes,
        start_date=start_date,
        days=args.days,
        workers=args.workers,
        chunk_days=args.chunk_days,
        batch_size=args.batch_size,
        conn=conn,
    )
    generated_seconds = round(time.perf_counter() - start, 3)

    end_date = start_date + timedelta(days=args.days - 1)
    summary = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "runId": run_id,
        "source": "OceanBase annual route-day aggregate simulation",
        "database": "chinahsr" if not args.skip_db else "skipped",
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat(),
        "days": args.days,
        "stationCount": len(stations),
        "routeCount": len(routes),
        "routeContract": build_route_contract_summary(routes, rail_features),
        "routeDayRows": totals["route_day_rows"],
        "totalTrainServices": totals["total_train_services"],
        "estimatedPassengers": totals["estimated_passengers"],
        "estimatedRevenue": round(totals["estimated_revenue"], 2),
        "surgeDayCount": totals["surge_day_count"],
        "workerCount": args.workers,
        "cpuCount": os.cpu_count() or 1,
        "chunkDays": args.chunk_days,
        "generatedSeconds": generated_seconds,
        "dailyAverages": {
            "trainServices": round(totals["total_train_services"] / args.days, 1),
            "passengers": round(totals["estimated_passengers"] / args.days, 1),
            "revenue": round(totals["estimated_revenue"] / args.days, 2),
        },
        "calendar": build_calendar_summary(start_date, args.days),
        "oceanbase": {
            "enabled": not args.skip_db,
            "tables": {},
        },
        "architecture": {
            "browserDetailedMode": "rolling-day seat-level Web Worker",
            "yearlyPersistenceMode": "OceanBase route-day aggregate facts",
            "routeContractMode": "OceanBase route variants + ordered stops + per-segment geometry",
            "rendering": "Mapbox WebGL",
            "computeParallelism": "Python multiprocessing for annual generation; browser Web Worker for live day",
        },
    }

    if conn is not None:
        upsert_simulation_run(conn, summary, str(summary_path))
        summary["oceanbase"]["tables"] = query_table_counts(conn, run_id)
        conn.close()

    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "[oceanbase:seed] "
        f"run={run_id} days={args.days} routes={len(routes)} route_day_rows={totals['route_day_rows']} "
        f"trains={totals['total_train_services']} passengers={totals['estimated_passengers']} "
        f"revenue={round(totals['estimated_revenue'], 2)} workers={args.workers} "
        f"db={'skipped' if args.skip_db else 'loaded'} summary={summary_path}"
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed OceanBase with a full-year China HSR simulation.")
    parser.add_argument("--start-date", default=DEFAULT_START_DATE)
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS)
    parser.add_argument("--workers", type=int, default=default_worker_count())
    parser.add_argument("--chunk-days", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=4000)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--summary-path", default=str(DEFAULT_SUMMARY_PATH))
    parser.add_argument("--skip-db", action="store_true", help="Generate summary without connecting to OceanBase.")
    args = parser.parse_args()
    if args.days < 1:
        parser.error("--days must be at least 1")
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    if args.chunk_days < 1:
        parser.error("--chunk-days must be at least 1")
    if args.batch_size < 100:
        parser.error("--batch-size must be at least 100")
    return args


def default_worker_count() -> int:
    configured = os.environ.get("CHINAHSR_WORKERS")
    if configured and configured.isdigit():
        return max(1, int(configured))
    return max(1, min(os.cpu_count() or 4, 12))


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_db_config() -> dict[str, Any]:
    password = os.environ.get("OB_PASSWORD")
    if not password:
        raise SystemExit("OB_PASSWORD is required unless --skip-db is used. No database password is stored in source.")
    return {
        "host": os.environ.get("OB_HOST", "127.0.0.1"),
        "port": int(os.environ.get("OB_PORT", "2881")),
        "user": os.environ.get("OB_USER", "root"),
        "password": password,
        "database": os.environ.get("OB_DATABASE", "chinahsr"),
    }


def connect_oceanbase(config: dict[str, Any]):
    try:
        import pymysql
    except ImportError as exc:
        raise SystemExit("PyMySQL is required for OceanBase loading. Install it with python3 -m pip install PyMySQL.") from exc
    try:
        return pymysql.connect(
            host=config["host"],
            port=config["port"],
            user=config["user"],
            password=config["password"],
            database=config["database"],
            charset="utf8mb4",
            autocommit=False,
            connect_timeout=8,
        )
    except pymysql.err.OperationalError as exc:
        raise SystemExit(
            "Unable to connect to OceanBase at "
            f"{config['host']}:{config['port']} database={config['database']}. "
            "Start OceanBase Desktop / the MySQL-mode tenant, verify OB_HOST/OB_PORT/OB_DATABASE/OB_USER, "
            "or run with --skip-db to produce a local annual summary without loading tables. "
            f"Driver error: {exc.args[0] if exc.args else exc}"
        ) from None


def load_static_dimension_tables(conn, stations: list[dict[str, Any]], routes: list[dict[str, Any]], batch_size: int) -> None:
    station_rows = [
        (
            value(station, "id"),
            value(station, "name"),
            value(station, "province"),
            value(station, "city"),
            value(station, "bureau"),
            value(station, "kind"),
            value(station, "tier"),
            number(station, "lng"),
            number(station, "lat"),
            int(station.get("sourceCount") or 0),
        )
        for station in stations
    ]
    route_rows = []
    stop_rows = []
    segment_rows = []
    for route in routes:
        route_rows.append(
            (
                value(route, "id"),
                value(route, "code"),
                value(route, "trainNo"),
                value(route, "type"),
                value(route, "origin"),
                value(route, "destination"),
                value(route, "originProvince"),
                value(route, "destinationProvince"),
                value(route, "corridor"),
                number(route, "totalDistanceKm"),
                number(route, "frequencyRank"),
                len(route.get("stops", [])),
                len(route.get("segments", [])),
                value(route, "provenance"),
            )
        )
        for stop_index, stop in enumerate(route.get("stops", [])):
            stop_rows.append(
                (
                    value(route, "id"),
                    stop_index,
                    value(stop, "id"),
                    value(stop, "name"),
                    value(stop, "province"),
                    value(stop, "city"),
                    value(stop, "tier"),
                    number(stop, "lng"),
                    number(stop, "lat"),
                    int(stop.get("dwellMinutes") or 0),
                    1 if stop.get("simulatedStop") else 0,
                )
            )
        for segment_index, segment in enumerate(route.get("segments", [])):
            segment_rows.append(
                (
                    value(route, "id"),
                    segment_index,
                    value(segment, "from"),
                    value(segment, "to"),
                    number(segment, "distanceKm"),
                    int(segment.get("speedLimitKmh") or 0),
                    value(segment, "track"),
                    value(segment, "signaling"),
                    value(segment, "geometrySource"),
                    len(segment.get("geometry", []) or []),
                )
            )

    bulk_execute(
        conn,
        """
        INSERT INTO stations
          (station_id, name, province, city, bureau, kind, tier, lng, lat, source_count)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          name=VALUES(name), province=VALUES(province), city=VALUES(city), bureau=VALUES(bureau),
          kind=VALUES(kind), tier=VALUES(tier), lng=VALUES(lng), lat=VALUES(lat), source_count=VALUES(source_count)
        """,
        station_rows,
        batch_size,
    )
    bulk_execute(
        conn,
        """
        INSERT INTO routes
          (route_id, code, train_no, route_type, origin, destination, origin_province, destination_province,
           corridor, total_distance_km, frequency_rank, stop_count, segment_count, provenance)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          code=VALUES(code), train_no=VALUES(train_no), route_type=VALUES(route_type), origin=VALUES(origin),
          destination=VALUES(destination), origin_province=VALUES(origin_province),
          destination_province=VALUES(destination_province), corridor=VALUES(corridor),
          total_distance_km=VALUES(total_distance_km), frequency_rank=VALUES(frequency_rank),
          stop_count=VALUES(stop_count), segment_count=VALUES(segment_count), provenance=VALUES(provenance)
        """,
        route_rows,
        batch_size,
    )
    bulk_execute(
        conn,
        """
        INSERT INTO route_stops
          (route_id, stop_index, station_id, name, province, city, tier, lng, lat, dwell_minutes, simulated_stop)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          station_id=VALUES(station_id), name=VALUES(name), province=VALUES(province), city=VALUES(city),
          tier=VALUES(tier), lng=VALUES(lng), lat=VALUES(lat), dwell_minutes=VALUES(dwell_minutes),
          simulated_stop=VALUES(simulated_stop)
        """,
        stop_rows,
        batch_size,
    )
    bulk_execute(
        conn,
        """
        INSERT INTO route_segments
          (route_id, segment_index, from_station, to_station, distance_km, speed_limit_kmh,
           track_type, signaling, geometry_source, geometry_point_count)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          from_station=VALUES(from_station), to_station=VALUES(to_station), distance_km=VALUES(distance_km),
          speed_limit_kmh=VALUES(speed_limit_kmh), track_type=VALUES(track_type), signaling=VALUES(signaling),
          geometry_source=VALUES(geometry_source), geometry_point_count=VALUES(geometry_point_count)
        """,
        segment_rows,
        batch_size,
    )


def generate_and_optionally_insert_daily_rows(
    *,
    run_id: str,
    routes: list[dict[str, Any]],
    start_date: date,
    days: int,
    workers: int,
    chunk_days: int,
    batch_size: int,
    conn,
) -> dict[str, float]:
    totals = {
        "route_day_rows": 0,
        "total_train_services": 0,
        "estimated_passengers": 0,
        "estimated_revenue": 0.0,
        "surge_day_count": 0,
    }
    daily_rollups: list[tuple[Any, ...]] = []
    tasks = [(run_id, start_date.isoformat(), start_day, min(days, start_day + chunk_days)) for start_day in range(0, days, chunk_days)]
    completed_chunks = 0
    total_chunks = len(tasks)
    context = get_context("spawn")
    with context.Pool(processes=workers, initializer=initialize_worker, initargs=(routes,)) as pool:
        for result in pool.imap_unordered(generate_day_chunk, tasks):
            for key in totals:
                totals[key] += result[key]
            daily_rollups.extend(result.get("daily_rollups", []))
            if conn is not None:
                insert_daily_rows(conn, result["rows"], batch_size)
            completed_chunks += 1
            if completed_chunks % max(1, total_chunks // 10) == 0 or completed_chunks == total_chunks:
                log(f"  progress: {completed_chunks}/{total_chunks} chunks ({(completed_chunks / total_chunks) * 100:.0f}%)")
    if conn is not None and daily_rollups:
        insert_calendar_summary(conn, daily_rollups, batch_size)
    return totals


def initialize_worker(routes: list[dict[str, Any]]) -> None:
    global WORKER_ROUTES
    WORKER_ROUTES = routes


def generate_day_chunk(task: tuple[str, str, int, int]) -> dict[str, Any]:
    run_id, start_iso, start_day, end_day = task
    start_date = date.fromisoformat(start_iso)
    rows = []
    daily_rollups = []
    totals = {
        "route_day_rows": 0,
        "total_train_services": 0,
        "estimated_passengers": 0,
        "estimated_revenue": 0.0,
        "surge_day_count": 0,
    }
    for day_index in range(start_day, end_day):
        current_date = start_date + timedelta(days=day_index)
        calendar = calendar_state(current_date, day_index)
        if calendar["demandMultiplier"] > 1.001:
            totals["surge_day_count"] += 1
        day_train_services = 0
        day_passengers = 0
        day_revenue = 0.0
        for route in WORKER_ROUTES:
            service_count = service_count_for_route(route, calendar)
            estimate = estimate_route_day(route, service_count, calendar)
            rows.append(
                (
                    run_id,
                    current_date.isoformat(),
                    day_index,
                    route["id"],
                    service_count,
                    calendar["demandMultiplier"],
                    calendar["capacityMultiplier"],
                    calendar["priceSurgeMultiplier"],
                    estimate["passengers"],
                    round(estimate["revenue"], 2),
                    1 if calendar["isWeekend"] else 0,
                    1 if calendar["isHoliday"] else 0,
                    calendar["label"],
                )
            )
            totals["route_day_rows"] += 1
            totals["total_train_services"] += service_count
            totals["estimated_passengers"] += estimate["passengers"]
            totals["estimated_revenue"] += estimate["revenue"]
            day_train_services += service_count
            day_passengers += estimate["passengers"]
            day_revenue += estimate["revenue"]
        daily_rollups.append((
            run_id,
            current_date.isoformat(),
            day_index,
            calendar["dayOfWeek"],
            1 if calendar["isWeekend"] else 0,
            1 if calendar["isHoliday"] else 0,
            calendar["label"],
            calendar["demandMultiplier"],
            calendar["capacityMultiplier"],
            calendar["priceSurgeMultiplier"],
            day_train_services,
            day_passengers,
            round(day_revenue, 2),
        ))
    totals["rows"] = rows
    totals["daily_rollups"] = daily_rollups
    return totals


def load_route_geometry(conn, routes: list[dict[str, Any]], batch_size: int) -> None:
    rows = []
    for route in routes:
        for segment_index, segment in enumerate(route.get("segments", [])):
            geometry = segment.get("geometry") or []
            rows.append((
                value(route, "id"),
                segment_index,
                value(segment, "geometrySource"),
                len(geometry),
                json.dumps(geometry, separators=(",", ":")),
            ))
    if not rows:
        return
    bulk_execute(
        conn,
        """
        INSERT INTO route_geometry
          (route_id, segment_index, geometry_source, coordinate_count, coordinates_json)
        VALUES (%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          geometry_source=VALUES(geometry_source),
          coordinate_count=VALUES(coordinate_count),
          coordinates_json=VALUES(coordinates_json)
        """,
        rows,
        batch_size,
    )


def load_route_variants(conn, routes: list[dict[str, Any]], batch_size: int) -> None:
    variant_rows = []
    stop_rows = []
    segment_rows = []
    geometry_rows = []
    for route in routes:
        for variant in route_variants(route):
            variant_rows.append(
                (
                    variant["variant_id"],
                    value(route, "id"),
                    variant["direction"],
                    variant["origin"],
                    variant["destination"],
                    variant["origin_province"],
                    variant["destination_province"],
                    len(variant["stops"]),
                    len(variant["segments"]),
                    number(route, "totalDistanceKm"),
                    variant["stop_sequence_hash"],
                    json.dumps([stop.get("name") for stop in variant["stops"]], ensure_ascii=False, separators=(",", ":")),
                    value(route, "provenance"),
                    1,
                )
            )
            for stop_index, stop in enumerate(variant["stops"]):
                stop_rows.append(
                    (
                        variant["variant_id"],
                        value(route, "id"),
                        variant["direction"],
                        stop_index,
                        value(stop, "id"),
                        value(stop, "name"),
                        value(stop, "province"),
                        value(stop, "city"),
                        value(stop, "tier"),
                        number(stop, "lng"),
                        number(stop, "lat"),
                        int(stop.get("dwellMinutes") or 0),
                        1 if stop.get("simulatedStop") else 0,
                    )
                )
            for segment_index, segment in enumerate(variant["segments"]):
                geometry = segment.get("geometry") or []
                segment_rows.append(
                    (
                        variant["variant_id"],
                        value(route, "id"),
                        variant["direction"],
                        segment_index,
                        value(segment, "from"),
                        value(segment, "to"),
                        number(segment, "distanceKm"),
                        int(segment.get("speedLimitKmh") or 0),
                        value(segment, "track"),
                        value(segment, "signaling"),
                        value(segment, "geometrySource"),
                        len(geometry),
                    )
                )
                geometry_rows.append(
                    (
                        variant["variant_id"],
                        value(route, "id"),
                        variant["direction"],
                        segment_index,
                        value(segment, "geometrySource"),
                        len(geometry),
                        json.dumps(geometry, separators=(",", ":")),
                    )
                )

    bulk_execute(
        conn,
        """
        INSERT INTO route_variants
          (route_variant_id, route_id, direction, origin, destination, origin_province, destination_province,
           stop_count, segment_count, total_distance_km, stop_sequence_hash, stop_sequence_json, provenance, is_active)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          route_id=VALUES(route_id), direction=VALUES(direction), origin=VALUES(origin), destination=VALUES(destination),
          origin_province=VALUES(origin_province), destination_province=VALUES(destination_province),
          stop_count=VALUES(stop_count), segment_count=VALUES(segment_count), total_distance_km=VALUES(total_distance_km),
          stop_sequence_hash=VALUES(stop_sequence_hash), stop_sequence_json=VALUES(stop_sequence_json),
          provenance=VALUES(provenance), is_active=VALUES(is_active)
        """,
        variant_rows,
        batch_size,
    )
    bulk_execute(
        conn,
        """
        INSERT INTO route_variant_stops
          (route_variant_id, route_id, direction, stop_index, station_id, name, province, city, tier,
           lng, lat, dwell_minutes, simulated_stop)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          route_id=VALUES(route_id), direction=VALUES(direction), station_id=VALUES(station_id),
          name=VALUES(name), province=VALUES(province), city=VALUES(city), tier=VALUES(tier),
          lng=VALUES(lng), lat=VALUES(lat), dwell_minutes=VALUES(dwell_minutes), simulated_stop=VALUES(simulated_stop)
        """,
        stop_rows,
        batch_size,
    )
    bulk_execute(
        conn,
        """
        INSERT INTO route_variant_segments
          (route_variant_id, route_id, direction, segment_index, from_station, to_station,
           distance_km, speed_limit_kmh, track_type, signaling, geometry_source, geometry_point_count)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          route_id=VALUES(route_id), direction=VALUES(direction), from_station=VALUES(from_station),
          to_station=VALUES(to_station), distance_km=VALUES(distance_km), speed_limit_kmh=VALUES(speed_limit_kmh),
          track_type=VALUES(track_type), signaling=VALUES(signaling), geometry_source=VALUES(geometry_source),
          geometry_point_count=VALUES(geometry_point_count)
        """,
        segment_rows,
        batch_size,
    )
    bulk_execute(
        conn,
        """
        INSERT INTO route_variant_geometry
          (route_variant_id, route_id, direction, segment_index, geometry_source, coordinate_count, coordinates_json)
        VALUES (%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          route_id=VALUES(route_id), direction=VALUES(direction), geometry_source=VALUES(geometry_source),
          coordinate_count=VALUES(coordinate_count), coordinates_json=VALUES(coordinates_json)
        """,
        geometry_rows,
        batch_size,
    )


def load_rail_tracks(conn, rail_features: list[dict[str, Any]], batch_size: int) -> None:
    rows = []
    for index, feature in enumerate(rail_features):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        osm_id = str(props.get("osm_id") or "")
        track_id = f"rail-{osm_id or 'feature'}-{index}"
        rows.append(
            (
                track_id,
                osm_id,
                str(props.get("name") or ""),
                str(props.get("gauge") or ""),
                str(props.get("electrified") or ""),
                str(props.get("usage") or ""),
                1 if props.get("hsr") else 0,
                len(coordinates),
                json.dumps(props, ensure_ascii=False, separators=(",", ":")),
                json.dumps(geometry, ensure_ascii=False, separators=(",", ":")),
            )
        )
    if not rows:
        return
    bulk_execute(
        conn,
        """
        INSERT INTO rail_tracks
          (rail_track_id, osm_id, name, gauge, electrified, usage_type, hsr,
           coordinate_count, properties_json, geometry_json)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          osm_id=VALUES(osm_id), name=VALUES(name), gauge=VALUES(gauge), electrified=VALUES(electrified),
          usage_type=VALUES(usage_type), hsr=VALUES(hsr), coordinate_count=VALUES(coordinate_count),
          properties_json=VALUES(properties_json), geometry_json=VALUES(geometry_json)
        """,
        rows,
        batch_size,
    )


def route_variants(route: dict[str, Any]) -> list[dict[str, Any]]:
    route_id = value(route, "id")
    contract = route.get("routeContract") or {}
    stops = route.get("stops", [])
    segments = route.get("segments", [])
    return [
        {
            "variant_id": contract.get("outboundVariantId") or f"{route_id}:outbound",
            "direction": "outbound",
            "origin": value(route, "origin"),
            "destination": value(route, "destination"),
            "origin_province": value(route, "originProvince"),
            "destination_province": value(route, "destinationProvince"),
            "stops": stops,
            "segments": segments,
            "stop_sequence_hash": contract.get("stopSequenceHash") or stop_sequence_hash(stops),
        },
        {
            "variant_id": contract.get("returnVariantId") or f"{route_id}:return",
            "direction": "return",
            "origin": value(route, "destination"),
            "destination": value(route, "origin"),
            "origin_province": value(route, "destinationProvince"),
            "destination_province": value(route, "originProvince"),
            "stops": list(reversed(stops)),
            "segments": [reverse_segment(segment) for segment in reversed(segments)],
            "stop_sequence_hash": stop_sequence_hash(list(reversed(stops))),
        },
    ]


def reverse_segment(segment: dict[str, Any]) -> dict[str, Any]:
    reversed_segment = dict(segment)
    reversed_segment["from"] = value(segment, "to")
    reversed_segment["to"] = value(segment, "from")
    reversed_segment["geometry"] = list(reversed(segment.get("geometry") or []))
    return reversed_segment


def stop_sequence_hash(stops: list[dict[str, Any]]) -> str:
    payload = ">".join(str(stop.get("id") or stop.get("name") or "") for stop in stops)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def build_route_contract_summary(routes: list[dict[str, Any]], rail_features: list[dict[str, Any]]) -> dict[str, int]:
    stop_rows = sum(len(route.get("stops", [])) for route in routes)
    segment_rows = sum(len(route.get("segments", [])) for route in routes)
    return {
        "routeVariants": len(routes) * 2,
        "routeVariantStops": stop_rows * 2,
        "routeVariantSegments": segment_rows * 2,
        "routeVariantGeometry": segment_rows * 2,
        "railTracks": len(rail_features),
    }


def insert_calendar_summary(conn, rows: list[tuple[Any, ...]], batch_size: int) -> None:
    bulk_execute(
        conn,
        """
        INSERT INTO calendar_summary
          (run_id, service_date, day_index, day_of_week, is_weekend, is_holiday, calendar_label,
           demand_multiplier, capacity_multiplier, price_surge_multiplier,
           total_train_services, total_passengers, total_revenue)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          day_of_week=VALUES(day_of_week), is_weekend=VALUES(is_weekend), is_holiday=VALUES(is_holiday),
          calendar_label=VALUES(calendar_label), demand_multiplier=VALUES(demand_multiplier),
          capacity_multiplier=VALUES(capacity_multiplier), price_surge_multiplier=VALUES(price_surge_multiplier),
          total_train_services=VALUES(total_train_services), total_passengers=VALUES(total_passengers),
          total_revenue=VALUES(total_revenue)
        """,
        rows,
        batch_size,
    )


def insert_daily_rows(conn, rows: list[tuple[Any, ...]], batch_size: int) -> None:
    bulk_execute(
        conn,
        """
        INSERT INTO daily_route_services
          (run_id, service_date, day_index, route_id, service_count, demand_multiplier, capacity_multiplier,
           price_surge_multiplier, estimated_passengers, estimated_revenue, is_weekend, is_holiday, calendar_label)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          service_count=VALUES(service_count), demand_multiplier=VALUES(demand_multiplier),
          capacity_multiplier=VALUES(capacity_multiplier), price_surge_multiplier=VALUES(price_surge_multiplier),
          estimated_passengers=VALUES(estimated_passengers), estimated_revenue=VALUES(estimated_revenue),
          is_weekend=VALUES(is_weekend), is_holiday=VALUES(is_holiday), calendar_label=VALUES(calendar_label)
        """,
        rows,
        batch_size,
    )


def bulk_execute(conn, sql: str, rows: list[tuple[Any, ...]], batch_size: int) -> None:
    if not rows:
        return
    with conn.cursor() as cursor:
        for start in range(0, len(rows), batch_size):
            cursor.executemany(sql, rows[start:start + batch_size])
            conn.commit()


def upsert_simulation_run(conn, summary: dict[str, Any], summary_path: str) -> None:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO simulation_runs
              (run_id, start_date, end_date, days, route_count, station_count, worker_count, chunk_days,
               total_route_day_rows, total_train_services, estimated_passengers, estimated_revenue,
               surge_day_count, generated_seconds, summary_json_path)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
              start_date=VALUES(start_date), end_date=VALUES(end_date), days=VALUES(days),
              route_count=VALUES(route_count), station_count=VALUES(station_count), worker_count=VALUES(worker_count),
              chunk_days=VALUES(chunk_days), total_route_day_rows=VALUES(total_route_day_rows),
              total_train_services=VALUES(total_train_services), estimated_passengers=VALUES(estimated_passengers),
              estimated_revenue=VALUES(estimated_revenue), surge_day_count=VALUES(surge_day_count),
              generated_seconds=VALUES(generated_seconds), summary_json_path=VALUES(summary_json_path)
            """,
            (
                summary["runId"],
                summary["startDate"],
                summary["endDate"],
                summary["days"],
                summary["routeCount"],
                summary["stationCount"],
                summary["workerCount"],
                summary["chunkDays"],
                summary["routeDayRows"],
                summary["totalTrainServices"],
                summary["estimatedPassengers"],
                summary["estimatedRevenue"],
                summary["surgeDayCount"],
                summary["generatedSeconds"],
                summary_path,
            ),
        )
    conn.commit()


def query_table_counts(conn, run_id: str) -> dict[str, int]:
    queries = {
        "stations": ("SELECT COUNT(*) FROM stations", None),
        "routes": ("SELECT COUNT(*) FROM routes", None),
        "routeStops": ("SELECT COUNT(*) FROM route_stops", None),
        "routeSegments": ("SELECT COUNT(*) FROM route_segments", None),
        "routeGeometry": ("SELECT COUNT(*) FROM route_geometry", None),
        "routeVariants": ("SELECT COUNT(*) FROM route_variants", None),
        "routeVariantStops": ("SELECT COUNT(*) FROM route_variant_stops", None),
        "routeVariantSegments": ("SELECT COUNT(*) FROM route_variant_segments", None),
        "routeVariantGeometry": ("SELECT COUNT(*) FROM route_variant_geometry", None),
        "railTracks": ("SELECT COUNT(*) FROM rail_tracks", None),
        "simulationRuns": ("SELECT COUNT(*) FROM simulation_runs", None),
        "dailyRouteServicesForRun": ("SELECT COUNT(*) FROM daily_route_services WHERE run_id = %s", (run_id,)),
        "calendarSummaryForRun": ("SELECT COUNT(*) FROM calendar_summary WHERE run_id = %s", (run_id,)),
    }
    counts: dict[str, int] = {}
    with conn.cursor() as cursor:
        for key, (sql, params) in queries.items():
            try:
                cursor.execute(sql, params)
                counts[key] = int(cursor.fetchone()[0])
            except Exception as exc:  # noqa: BLE001
                counts[key] = 0
                log(f"  warning: count query for {key} failed: {exc}")
    return counts


def calendar_state(current_date: date, day_index: int) -> dict[str, Any]:
    day_of_week = (current_date.weekday() + 1) % 7
    weekend = day_of_week in (0, 6)
    day_of_year = current_date.timetuple().tm_yday
    holiday = window_for_day(
        day_of_year,
        [
            (1, 3, "New Year travel surge", 1.58, 1.34, 1.28),
            (14, 53, "Spring Festival Chunyun", 1.95, 1.52, 1.42),
            (94, 96, "Qingming holiday", 1.42, 1.24, 1.20),
            (121, 125, "Labor Day golden week", 1.72, 1.38, 1.34),
            (170, 172, "Dragon Boat holiday", 1.36, 1.18, 1.17),
            (274, 281, "National Day golden week", 1.86, 1.46, 1.38),
        ],
    )
    peak = window_for_day(
        day_of_year,
        [
            (182, 243, "Summer student travel peak", 1.28, 1.16, 1.12),
            (354, 365, "Year-end travel peak", 1.20, 1.10, 1.08),
        ],
    )
    labels: list[str] = []
    demand = 1.0
    capacity = 1.0
    price = 1.0
    if weekend:
        demand *= 1.18
        capacity *= 1.08
        price *= 1.06
        labels.append("Weekend")
    for item in (peak, holiday):
        if item:
            label, demand_factor, capacity_factor, price_factor = item
            demand *= demand_factor
            capacity *= capacity_factor
            price *= price_factor
            labels.append(label)
    return {
        "dateIso": current_date.isoformat(),
        "dayIndex": day_index,
        "dayOfWeek": day_of_week,
        "isWeekend": weekend,
        "isHoliday": holiday is not None,
        "label": " + ".join(labels) if labels else "Normal weekday",
        "demandMultiplier": round(demand, 3),
        "capacityMultiplier": round(capacity, 3),
        "priceSurgeMultiplier": round(price, 3),
    }


def window_for_day(day_of_year: int, windows: list[tuple[int, int, str, float, float, float]]):
    for start, end, label, demand, capacity, price in windows:
        if start <= day_of_year <= end:
            return label, demand, capacity, price
    return None


def service_count_for_route(route: dict[str, Any], calendar: dict[str, Any]) -> int:
    rank = max(0.0, min(1.0, float(route.get("frequencyRank") or 0.08)))
    stops = route.get("stops", [])
    origin_tier = stops[0].get("tier") if stops else ""
    destination_tier = stops[-1].get("tier") if stops else ""
    hub_score = tier_score(origin_tier) + tier_score(destination_tier)
    distance = float(route.get("totalDistanceKm") or 0)
    if distance > 1600:
        distance_score = 2.4
    elif distance > 900:
        distance_score = 1.7
    elif distance > 350:
        distance_score = 1.1
    else:
        distance_score = 0.55
    corridor = route.get("corridor") or ""
    corridor_score = 1.15 if "East China" in corridor or "North China" in corridor else 0.55
    service_noise = stable_noise(f"{route.get('id')}:{route.get('code')}:service-plan") * 2.4
    trunk_bonus = 5 if rank > 0.85 else 3 if rank > 0.65 else 1 if rank > 0.35 else 0
    baseline = MIN_DAILY_TRAINS_PER_ROUTE + round_js(
        2.2 + math.sqrt(rank) * 5.4 + hub_score + distance_score + corridor_score + service_noise + trunk_bonus
    )
    surge_extras = round_js(
        max(0, baseline - MIN_DAILY_TRAINS_PER_ROUTE)
        * max(0.0, float(calendar["capacityMultiplier"]) - 1.0)
        * 0.92
    )
    holiday_floor = 1 if float(calendar["demandMultiplier"]) >= 1.35 else 0
    return max(MIN_DAILY_TRAINS_PER_ROUTE, int(baseline + surge_extras + holiday_floor))


def estimate_route_day(route: dict[str, Any], service_count: int, calendar: dict[str, Any]) -> dict[str, float]:
    intensity = route_demand_intensity(route)
    distance = max(80.0, float(route.get("totalDistanceKm") or 120.0))
    day_noise = stable_noise(f"{route.get('id')}:{calendar['dateIso']}:annual-demand")
    target_load = min(
        0.985,
        max(
            0.42,
            0.50
            + intensity * 0.19
            + (float(calendar["demandMultiplier"]) - 1.0) * 0.13
            + day_noise * 0.08,
        ),
    )
    passengers = round_js(service_count * TRAIN_SEAT_QUOTA * target_load)
    average_trip_km = min(1500.0, max(80.0, distance * (0.52 + min(0.18, intensity * 0.08))))
    distance_discount = 0.88 if average_trip_km > 1200 else 0.92 if average_trip_km > 800 else 0.96 if average_trip_km > 500 else 1.0
    class_mix_multiplier = 0.805 * 1.0 + 0.165 * 1.75 + 0.03 * 3.1
    load_scarcity = 1.0 + max(0.0, target_load - 0.62) * 0.58
    calendar_pressure = 1.0 + max(0.0, float(calendar["demandMultiplier"]) - 1.0) * 0.045
    average_fare = (
        average_trip_km
        * BASE_SECOND_CLASS_YUAN_PER_KM
        * class_mix_multiplier
        * distance_discount
        * float(calendar["priceSurgeMultiplier"])
        * load_scarcity
        * calendar_pressure
    )
    return {"passengers": int(passengers), "revenue": float(passengers) * average_fare, "targetLoad": target_load}


def route_demand_intensity(route: dict[str, Any]) -> float:
    rank = float(route.get("frequencyRank") or 0.08)
    corridor = route.get("corridor") or ""
    corridor_boost = 0.18 if "East China" in corridor or "North China" in corridor else 0.04
    distance = float(route.get("totalDistanceKm") or 0)
    distance_boost = 0.08 if distance > 900 else 0.04 if distance < 300 else 0.12
    stops = route.get("stops", [])
    origin_tier = stops[0].get("tier") if stops else ""
    destination_tier = stops[-1].get("tier") if stops else ""
    hub_boost = (tier_score(origin_tier) + tier_score(destination_tier)) / 6
    return max(0.65, min(1.45, 0.78 + math.sqrt(rank) * 0.45 + corridor_boost + distance_boost + hub_boost))


def tier_score(tier: str | None) -> float:
    if tier == "national-hub":
        return 1.4
    if tier == "regional-hub":
        return 0.75
    return 0.18


def build_calendar_summary(start_date: date, days: int) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for day_index in range(days):
        current = start_date + timedelta(days=day_index)
        calendar = calendar_state(current, day_index)
        label = calendar["label"]
        if label not in buckets:
            buckets[label] = {
                "label": label,
                "days": 0,
                "maxDemandMultiplier": 0,
                "maxPriceSurgeMultiplier": 0,
            }
        bucket = buckets[label]
        bucket["days"] += 1
        bucket["maxDemandMultiplier"] = max(bucket["maxDemandMultiplier"], calendar["demandMultiplier"])
        bucket["maxPriceSurgeMultiplier"] = max(bucket["maxPriceSurgeMultiplier"], calendar["priceSurgeMultiplier"])
    return sorted(buckets.values(), key=lambda item: (-item["maxDemandMultiplier"], item["label"]))


def stable_noise(key: str) -> float:
    hash_value = 2166136261
    for char in str(key):
        hash_value ^= ord(char)
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return (hash_value % 1_000_000) / 1_000_000


def round_js(value_to_round: float) -> int:
    return int(math.floor(value_to_round + 0.5))


def value(item: dict[str, Any], key: str) -> str:
    raw = item.get(key)
    return "" if raw is None else str(raw)


def number(item: dict[str, Any], key: str) -> float:
    raw = item.get(key)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("[oceanbase:seed] interrupted", file=sys.stderr)
        raise SystemExit(130)
