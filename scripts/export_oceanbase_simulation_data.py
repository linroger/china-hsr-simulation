#!/usr/bin/env python3
"""Export OceanBase 12306 route contracts into browser simulation JSON.

The browser worker already understands a compact `{stations, routes}` payload.
This script builds that payload from the `cr_12306_*` tables loaded by
`migrate_12306_to_oceanbase.py`, preserving the ordered stop sequence so trains
advance station-by-station and reverse through the same stations at terminals.
"""

from __future__ import annotations

import argparse
import heapq
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIR = ROOT / "public"
DEFAULT_TABLE_PREFIX = "cr_12306_"
MAX_STATIC_COORD_DEVIATION_KM = 50
MAX_STATION_TRACK_DEVIATION_KM = 50
MAX_RAIL_EDGE_KM = 120
CHINA_COORD_BOUNDS = (70.0, 15.0, 136.0, 55.0)
NATIONAL_HUB_NAMES = {
    "北京",
    "北京南",
    "北京西",
    "上海",
    "上海虹桥",
    "广州",
    "广州南",
    "深圳",
    "深圳北",
    "南京",
    "南京南",
    "杭州",
    "杭州东",
    "武汉",
    "汉口",
    "郑州",
    "郑州东",
    "西安",
    "西安北",
    "成都",
    "成都东",
    "重庆",
    "重庆北",
    "天津",
    "长沙南",
    "南昌西",
    "福州",
    "福州南",
    "厦门北",
    "济南",
    "济南西",
    "青岛",
    "青岛北",
    "合肥南",
    "昆明南",
    "南宁东",
    "贵阳北",
    "沈阳北",
    "大连北",
    "哈尔滨",
    "哈尔滨西",
    "长春",
    "长春西",
    "兰州西",
    "香港西九龙",
}


def main() -> int:
    args = parse_args()
    started = time.perf_counter()
    static_context = load_static_context()
    table_prefix = validate_prefix(args.table_prefix)

    if args.sqlite:
        conn = connect_sqlite(Path(args.sqlite).expanduser().resolve())
        dialect = "sqlite"
    else:
        conn = connect_oceanbase(allow_empty_password=args.allow_empty_password)
        dialect = "mysql"

    try:
        source = load_source_rows(conn, table_prefix=table_prefix if dialect == "mysql" else "", dialect=dialect)
    finally:
        conn.close()

    payload = build_simulation_payload(
        source,
        static_context=static_context,
        include_all_classes=args.include_all_classes,
        route_limit=args.route_limit,
    )
    payload["metadata"].update(
        {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "elapsedSeconds": round(time.perf_counter() - started, 3),
            "source": "oceanbase-12306" if not args.sqlite else "sqlite-12306-fixture",
            "tablePrefix": table_prefix,
            "highSpeedOnly": not args.include_all_classes,
        }
    )

    if args.stdout:
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    else:
        output_dir = Path(args.output_dir).expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        write_json(output_dir / "oceanbase-simulation-data.json", payload)
        write_json(output_dir / "oceanbase-station-data.json", {"stations": payload["stations"], "metadata": payload["metadata"]})
        write_json(output_dir / "oceanbase-route-data.json", {"routes": payload["routes"], "metadata": payload["metadata"]})
        geometry_meta = payload["metadata"]["geometry"]
        print(
            "[oceanbase:export] "
            f"routes={len(payload['routes']):,} stations={len(payload['stations']):,} "
            f"rail_graph_segments={geometry_meta['railGraphSegments']:,} "
            f"rail_corridor_segments={geometry_meta['railCorridorSegments']:,} "
            f"ordered_stop_fallbacks={geometry_meta['orderedStopEdgeSegments']:,} "
            f"output={output_dir} elapsed={payload['metadata']['elapsedSeconds']}s"
        )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export OceanBase 12306 route contracts for the China HSR browser simulation.")
    parser.add_argument("--table-prefix", default=DEFAULT_TABLE_PREFIX, help="Prefix for migrated 12306 OceanBase tables.")
    parser.add_argument("--output-dir", default=str(PUBLIC_DIR), help="Directory for exported JSON files.")
    parser.add_argument("--route-limit", type=int, default=0, help="Optional max route count after class filtering.")
    parser.add_argument("--include-all-classes", action="store_true", help="Include K/T/Z and other non-HSR classes.")
    parser.add_argument("--allow-empty-password", action="store_true", help="Allow empty OceanBase password for local Desktop only.")
    parser.add_argument("--sqlite", help="Read from a SQLite 12306-compatible fixture instead of OceanBase.")
    parser.add_argument("--stdout", action="store_true", help="Print the combined payload to stdout instead of writing files.")
    args = parser.parse_args()
    if args.route_limit < 0:
        parser.error("--route-limit cannot be negative")
    return args


def connect_sqlite(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise SystemExit(f"SQLite source not found: {path}")
    conn = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def connect_oceanbase(*, allow_empty_password: bool):
    try:
        import pymysql
        from pymysql.cursors import DictCursor
    except ImportError as exc:
        raise SystemExit("PyMySQL is required for OceanBase export. Install python3-pymysql in the OceanBase Desktop VM.") from exc

    password = os.environ.get("OB_PASSWORD", "")
    host = os.environ.get("OB_HOST", "127.0.0.1")
    port = int(os.environ.get("OB_PORT", "2881"))
    user = os.environ.get("OB_USER", "root")
    database = os.environ.get("OB_DATABASE", "chinahsr")
    if not password and not allow_empty_password:
        raise SystemExit(
            "OB_PASSWORD is required unless --allow-empty-password is set for a local OceanBase Desktop tenant."
        )
    try:
        return pymysql.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database=database,
            charset="utf8mb4",
            cursorclass=DictCursor,
            connect_timeout=3,
            read_timeout=120,
        )
    except pymysql.err.OperationalError as exc:
        raise SystemExit(
            f"Unable to query OceanBase at {host}:{port} database={database}. Driver error: {exc.args[0] if exc.args else exc}"
        ) from None


def load_source_rows(conn: Any, *, table_prefix: str, dialect: str) -> dict[str, Any]:
    tables = {
        "stations": table_prefix + "stations",
        "train_routes": table_prefix + "train_routes",
        "route_stations": table_prefix + "route_stations",
        "station_locations": table_prefix + "station_locations",
        "railway_tracks": table_prefix + "railway_tracks",
        "station_track_links": table_prefix + "station_track_links",
    }
    has_railway_tracks = table_exists(conn, tables["railway_tracks"], dialect)
    has_station_track_links = table_exists(conn, tables["station_track_links"], dialect)
    return {
        "stations": rows(conn, f"SELECT station_code, station_name, station_pinyin, city FROM {q(tables['stations'], dialect)}"),
        "stationLocations": rows(
            conn,
            f"""
            SELECT id, station_code, station_name, lon, lat
            FROM {q(tables['station_locations'], dialect)}
            WHERE lon IS NOT NULL AND lat IS NOT NULL
            ORDER BY id
            """,
        ),
        "trainRoutes": rows(
            conn,
            f"""
            SELECT id, train_no, train_code, depart_date, train_class_name, service_type, end_station_name
            FROM {q(tables['train_routes'], dialect)}
            ORDER BY id
            """,
        ),
        "routeStations": rows(
            conn,
            f"""
            SELECT train_route_id, station_name, station_order, arrive_time, start_time, lishi, arrive_day_str
            FROM {q(tables['route_stations'], dialect)}
            ORDER BY train_route_id, station_order
            """,
        ),
        "railwayTracks": rows(
            conn,
            f"""
            SELECT id, name, railway_type, geometry_json
            FROM {q(tables['railway_tracks'], dialect)}
            WHERE geometry_json IS NOT NULL
            ORDER BY id
            """,
        ) if has_railway_tracks else [],
        "stationTrackLinks": rows(
            conn,
            f"""
            SELECT station_code, track_id
            FROM {q(tables['station_track_links'], dialect)}
            ORDER BY station_code, track_id
            """,
        ) if has_station_track_links else [],
        "tableCounts": {
            name: int(scalar(conn, f"SELECT COUNT(*) FROM {q(table, dialect)}")) if table_exists(conn, table, dialect) else 0
            for name, table in tables.items()
        },
    }


def rows(conn: Any, sql: str) -> list[dict[str, Any]]:
    cursor = conn.execute(sql) if isinstance(conn, sqlite3.Connection) else conn.cursor()
    if isinstance(conn, sqlite3.Connection):
        return [dict(row) for row in cursor.fetchall()]
    try:
        cursor.execute(sql)
        return list(cursor.fetchall())
    finally:
        cursor.close()


def scalar(conn: Any, sql: str) -> Any:
    result = rows(conn, sql)
    if not result:
        return 0
    return next(iter(result[0].values()))


def table_exists(conn: Any, table: str, dialect: str) -> bool:
    try:
        rows(conn, f"SELECT 1 FROM {q(table, dialect)} LIMIT 1")
        return True
    except Exception:
        return False


def build_simulation_payload(
    source: dict[str, Any],
    *,
    static_context: dict[str, Any],
    include_all_classes: bool,
    route_limit: int,
) -> dict[str, Any]:
    rail_network = RailNetwork(source.get("railwayTracks", []), source.get("stationTrackLinks", []))
    station_by_name = build_station_lookup(source, static_context, rail_network)
    route_rows = {int(row["id"]): row for row in source["trainRoutes"]}
    stops_by_route: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in source["routeStations"]:
        stops_by_route[int(row["train_route_id"])].append(row)

    routes = []
    skipped_missing_coords = 0
    skipped_class = 0
    matched_static_segments = 0
    rail_graph_segments = 0
    rail_corridor_segments = 0
    fallback_segments = 0
    used_station_names: set[str] = set()
    class_counts: dict[str, int] = defaultdict(int)

    for route_id in sorted(route_rows):
        route_row = route_rows[route_id]
        train_type = infer_train_type(route_row)
        class_counts[train_type] += 1
        if not include_all_classes and train_type not in {"G", "D", "C"}:
            skipped_class += 1
            continue
        stop_rows = sorted(stops_by_route.get(route_id, []), key=lambda row: int(row["station_order"]))
        if len(stop_rows) < 2:
            continue
        stops = []
        missing = False
        for index, stop_row in enumerate(stop_rows):
            station = station_by_name.get(stop_row["station_name"])
            if not station:
                missing = True
                break
            stops.append(
                {
                    **station,
                    "simulatedStop": False,
                    "dwellMinutes": dwell_minutes(stop_row, index=index, total=len(stop_rows), station=station),
                    "arrivalTime": normalize_time(stop_row.get("arrive_time")),
                    "departureTime": normalize_time(stop_row.get("start_time")),
                    "elapsedTime": stop_row.get("lishi"),
                    "stationOrder": int(stop_row["station_order"]),
                }
            )
        if missing:
            skipped_missing_coords += 1
            print(f"[oceanbase:export] warning: skipping route {route_id} because stop '{stop_row['station_name']}' has no valid coordinates", file=sys.stderr)
            continue

        segments = []
        for index in range(len(stops) - 1):
            segment, matched = build_segment(
                stops[index],
                stops[index + 1],
                route_type=train_type,
                static_segments=static_context["segmentsByEdge"],
                rail_network=rail_network,
            )
            segments.append(segment)
            if matched == "rail-graph":
                rail_graph_segments += 1
            elif matched == "rail-corridor":
                rail_corridor_segments += 1
            elif matched == "static":
                matched_static_segments += 1
            else:
                fallback_segments += 1

        route_code = route_row.get("train_code") or route_row.get("train_no") or f"R{route_id}"
        route = {
            "id": f"ob12306-route-{route_id}-{safe_slug(route_code)}",
            "code": route_code,
            "trainNo": route_row.get("train_no") or route_code,
            "type": train_type,
            "origin": stops[0]["name"],
            "destination": stops[-1]["name"],
            "totalDistanceKm": round(sum(segment["distanceKm"] for segment in segments), 1),
            "frequencyRank": route_frequency_rank(train_type, len(stops)),
            "corridor": f"{stops[0].get('city') or stops[0].get('province') or 'Unknown'} / {stops[-1].get('city') or stops[-1].get('province') or 'Unknown'}",
            "originProvince": stops[0].get("province") or "",
            "destinationProvince": stops[-1].get("province") or "",
            "provenance": "OceanBase cr_12306 route_stations ordered stop contract; coordinates from cr_12306_station_locations with generated static-data fallback.",
            "routeContract": build_route_contract(route_id, route_code, stops),
            "stops": stops,
            "segments": segments,
            "geometry": merge_segment_geometry(segments),
        }
        routes.append(route)
        used_station_names.update(stop["name"] for stop in stops)
        if route_limit and len(routes) >= route_limit:
            break

    stations = sorted((station_by_name[name] for name in used_station_names), key=lambda row: (row.get("city") or "", row["name"]))
    return {
        "metadata": {
            "routeCount": len(routes),
            "stationCount": len(stations),
            "sourceTableCounts": source["tableCounts"],
            "skipped": {
                "nonHighSpeedClassRoutes": skipped_class,
                "missingCoordinateRoutes": skipped_missing_coords,
            },
            "trainTypeCounts": dict(sorted(class_counts.items())),
            "geometry": {
                "railGraphSegments": rail_graph_segments,
                "railCorridorSegments": rail_corridor_segments,
                "matchedStaticRailSegments": matched_static_segments,
                "orderedStopEdgeSegments": fallback_segments,
                "stationCoordinateCorrections": rail_network.coordinate_corrections,
                "railGraph": rail_network.summary(),
            },
        },
        "stations": stations,
        "routes": routes,
    }


def build_station_lookup(source: dict[str, Any], static_context: dict[str, Any], rail_network: "RailNetwork") -> dict[str, dict[str, Any]]:
    station_meta_by_name: dict[str, dict[str, Any]] = {}
    for row in source["stations"]:
        station_meta_by_name.setdefault(row["station_name"], row)

    location_by_name: dict[str, dict[str, Any]] = {}
    for row in source["stationLocations"]:
        name = row.get("station_name")
        if not name or name in location_by_name:
            continue
        lon = as_float(row.get("lon"))
        lat = as_float(row.get("lat"))
        if lon is None or lat is None:
            continue
        location_by_name[name] = {"lng": lon, "lat": lat}

    names = set(station_meta_by_name) | set(location_by_name) | set(static_context["stationsByName"])
    result: dict[str, dict[str, Any]] = {}
    for name in names:
        location = location_by_name.get(name)
        static_station = static_context["stationsByName"].get(name)
        meta = station_meta_by_name.get(name) or {}
        station_code = meta.get("station_code") or (static_station.get("id") if static_station else None)
        coordinate = choose_station_coordinate(
            name,
            station_code=station_code,
            db_coord=location,
            static_station=static_station,
            rail_network=rail_network,
        )
        if not coordinate:
            continue
        tier = static_station.get("tier") if static_station else tier_for_name(name)
        result[name] = {
            "id": station_code or f"ob-station-{stable_hash(name)}",
            "name": name,
            "address": static_station.get("address", "") if static_station else "",
            "bureau": static_station.get("bureau", "12306/OceanBase") if static_station else "12306/OceanBase",
            "kind": static_station.get("kind", "railway") if static_station else "railway",
            "province": static_station.get("province", "") if static_station else "",
            "city": meta.get("city") or (static_station.get("city", "") if static_station else ""),
            "lng": round(coordinate["lng"], 6),
            "lat": round(coordinate["lat"], 6),
            "sourceCount": static_station.get("sourceCount", 1) if static_station else 1,
            "source": "oceanbase-12306",
            "coordinateSource": coordinate["source"],
            "tier": tier,
        }
    return result


def choose_station_coordinate(
    name: str,
    *,
    station_code: Any,
    db_coord: dict[str, Any] | None,
    static_station: dict[str, Any] | None,
    rail_network: "RailNetwork",
) -> dict[str, Any] | None:
    db = coord_candidate(db_coord, "oceanbase-station-location")
    static = coord_candidate(static_station, "static-station-data")
    reference = static or db
    linked_track = rail_network.linked_track_coordinate(station_code, reference=reference) if station_code else None

    if db and static and haversine_km(db, static) > MAX_STATIC_COORD_DEVIATION_KM:
        rail_network.coordinate_corrections += 1
        if linked_track:
            db_track_km = haversine_km(db, linked_track)
            static_track_km = haversine_km(static, linked_track)
            if static_track_km <= MAX_STATION_TRACK_DEVIATION_KM or static_track_km < db_track_km:
                return {**static, "source": "static-coordinate-corrected"}
        return {**static, "source": "static-coordinate-corrected"}

    if db and linked_track and haversine_km(db, linked_track) > MAX_STATION_TRACK_DEVIATION_KM:
        rail_network.coordinate_corrections += 1
        if static and haversine_km(static, linked_track) < haversine_km(db, linked_track):
            return {**static, "source": "static-track-coordinate-corrected"}
        return {**linked_track, "source": "linked-track-coordinate-corrected"}

    if db:
        return db
    if static:
        return static
    if linked_track:
        return {**linked_track, "source": "linked-track-coordinate"}
    return None


def coord_candidate(row: dict[str, Any] | None, source: str) -> dict[str, Any] | None:
    if not row:
        return None
    lng = as_float(row.get("lng"))
    lat = as_float(row.get("lat"))
    if lng is None or lat is None or not in_china_bounds(lng, lat):
        return None
    return {"lng": lng, "lat": lat, "source": source}


class RailNetwork:
    def __init__(self, tracks: list[dict[str, Any]], links: list[dict[str, Any]]):
        self.node_cell_size = 0.0055
        self.lookup_cell_size = 0.04
        self.nodes: list[dict[str, Any]] = []
        self.cell_map: dict[tuple[int, int], int] = {}
        self.lookup_cells: dict[tuple[int, int], list[int]] = defaultdict(list)
        self.track_nodes: dict[int, list[int]] = {}
        self.station_track_ids: dict[str, list[int]] = defaultdict(list)
        self.station_anchor_cache: dict[str, int | None] = {}
        self.path_cache: dict[tuple[int, int], dict[str, Any] | None] = {}
        self.track_count = len(tracks)
        self.link_count = len(links)
        self.parse_errors = 0
        self.edge_count = 0
        self.coordinate_corrections = 0

        for row in links:
            station_code = str(row.get("station_code") or "").strip()
            track_id = as_int(row.get("track_id"))
            if station_code and track_id is not None:
                self.station_track_ids[station_code].append(track_id)

        self._build(tracks)

    def _build(self, tracks: list[dict[str, Any]]) -> None:
        for row in tracks:
            track_id = as_int(row.get("id"))
            coordinates = parse_linestring(row.get("geometry_json"))
            if track_id is None or not coordinates:
                if row.get("geometry_json"):
                    self.parse_errors += 1
                continue
            node_ids: list[int] = []
            previous_id: int | None = None
            for coord in coordinates:
                lng = as_float(coord[0] if len(coord) > 0 else None)
                lat = as_float(coord[1] if len(coord) > 1 else None)
                if lng is None or lat is None or not in_china_bounds(lng, lat):
                    continue
                node_id = self._find_or_create_node(lng, lat)
                if not node_ids or node_ids[-1] != node_id:
                    node_ids.append(node_id)
                if previous_id is not None and previous_id != node_id:
                    self._add_edge(previous_id, node_id)
                previous_id = node_id
            if node_ids:
                self.track_nodes[track_id] = node_ids

        for node_id, node in enumerate(self.nodes):
            node["neighborList"] = list(node["neighbors"].items())
            node["neighbors"] = None
            key = self._lookup_key(node["lng"], node["lat"])
            self.lookup_cells[key].append(node_id)

    def _find_or_create_node(self, lng: float, lat: float) -> int:
        key = (round(lng / self.node_cell_size), round(lat / self.node_cell_size))
        existing = self.cell_map.get(key)
        if existing is not None:
            node = self.nodes[existing]
            ref_count = node["refCount"]
            node["lng"] = (node["lng"] * ref_count + lng) / (ref_count + 1)
            node["lat"] = (node["lat"] * ref_count + lat) / (ref_count + 1)
            node["refCount"] = ref_count + 1
            return existing
        node_id = len(self.nodes)
        self.nodes.append({"lng": lng, "lat": lat, "refCount": 1, "neighbors": {}})
        self.cell_map[key] = node_id
        return node_id

    def _add_edge(self, a_id: int, b_id: int) -> None:
        a = self.nodes[a_id]
        b = self.nodes[b_id]
        distance = haversine_km(a, b)
        if distance <= 0 or distance > MAX_RAIL_EDGE_KM:
            return
        if b_id not in a["neighbors"]:
            self.edge_count += 1
        a["neighbors"][b_id] = min(distance, a["neighbors"].get(b_id, distance))
        b["neighbors"][a_id] = min(distance, b["neighbors"].get(a_id, distance))

    def _lookup_key(self, lng: float, lat: float) -> tuple[int, int]:
        return (math.floor(lng / self.lookup_cell_size), math.floor(lat / self.lookup_cell_size))

    def usable(self) -> bool:
        return bool(self.nodes and self.edge_count)

    def summary(self) -> dict[str, Any]:
        return {
            "sourceTracks": self.track_count,
            "sourceLinks": self.link_count,
            "nodes": len(self.nodes),
            "edges": self.edge_count,
            "parseErrors": self.parse_errors,
        }

    def linked_track_coordinate(self, station_code: Any, *, reference: dict[str, Any] | None = None) -> dict[str, Any] | None:
        node_ids = self._linked_node_ids(station_code)
        if not node_ids:
            return None
        if reference:
            best_id = min(node_ids, key=lambda node_id: haversine_km(reference, self.nodes[node_id]))
            node = self.nodes[best_id]
            return {"lng": node["lng"], "lat": node["lat"], "source": "linked-track-nearest"}
        lng = sum(self.nodes[node_id]["lng"] for node_id in node_ids) / len(node_ids)
        lat = sum(self.nodes[node_id]["lat"] for node_id in node_ids) / len(node_ids)
        if not in_china_bounds(lng, lat):
            return None
        return {"lng": lng, "lat": lat, "source": "linked-track-centroid"}

    def station_anchor(self, station: dict[str, Any], max_km: float) -> int | None:
        cache_key = f"{station.get('id') or station.get('name')}:{round(station['lng'], 4)}:{round(station['lat'], 4)}:{round(max_km)}"
        if cache_key in self.station_anchor_cache:
            return self.station_anchor_cache[cache_key]
        best_id: int | None = None
        best_km = max_km
        for node_id in self._linked_node_ids(station.get("id")):
            node = self.nodes[node_id]
            distance = haversine_km(station, node)
            if distance < best_km:
                best_id = node_id
                best_km = distance
        if best_id is None:
            nearest = self.find_nearest_node(station["lng"], station["lat"], max_km=max_km)
            best_id = nearest["id"] if nearest else None
        self.station_anchor_cache[cache_key] = best_id
        return best_id

    def _linked_node_ids(self, station_code: Any) -> list[int]:
        code = str(station_code or "").strip()
        if not code:
            return []
        node_ids: list[int] = []
        for track_id in self.station_track_ids.get(code, []):
            node_ids.extend(self.track_nodes.get(track_id, []))
        return node_ids

    def find_nearest_node(self, lng: float, lat: float, *, max_km: float) -> dict[str, Any] | None:
        if not self.nodes:
            return None
        cell_x, cell_y = self._lookup_key(lng, lat)
        best_id: int | None = None
        best_km = max_km
        max_radius = max(1, math.ceil(max_km / 4))
        for radius in range(max_radius + 1):
            found_bucket = False
            for dx in range(-radius, radius + 1):
                for dy in range(-radius, radius + 1):
                    if radius and abs(dx) != radius and abs(dy) != radius:
                        continue
                    bucket = self.lookup_cells.get((cell_x + dx, cell_y + dy))
                    if not bucket:
                        continue
                    found_bucket = True
                    for node_id in bucket:
                        node = self.nodes[node_id]
                        distance = haversine_km({"lng": lng, "lat": lat}, node)
                        if distance < best_km:
                            best_id = node_id
                            best_km = distance
            if best_id is not None and found_bucket:
                break
        return {"id": best_id, "km": best_km} if best_id is not None else None

    def shortest_path(self, start_id: int, goal_id: int, direct_km: float) -> dict[str, Any] | None:
        cache_key = (start_id, goal_id)
        if cache_key in self.path_cache:
            return self.path_cache[cache_key]
        if start_id == goal_id:
            return None
        goal = self.nodes[goal_id]
        max_km = max(120, direct_km * 2.35 + 35)
        iteration_cap = 140000 if direct_km > 500 else 90000
        distances = {start_id: 0.0}
        previous: dict[int, int] = {}
        visited: set[int] = set()
        heap: list[tuple[float, float, int]] = [(haversine_km(self.nodes[start_id], goal), 0.0, start_id)]
        iterations = 0
        while heap and iterations < iteration_cap:
            iterations += 1
            _, current_dist, current_id = heapq.heappop(heap)
            if current_id in visited:
                continue
            visited.add(current_id)
            if current_id == goal_id:
                node_path = []
                node = goal_id
                while node in previous:
                    node_path.append(node)
                    node = previous[node]
                node_path.append(start_id)
                node_path.reverse()
                result = {"nodes": node_path, "distanceKm": current_dist}
                self.path_cache[cache_key] = result
                return result
            if current_dist > max_km:
                continue
            for neighbor_id, edge_km in self.nodes[current_id].get("neighborList", []):
                if neighbor_id in visited:
                    continue
                next_dist = current_dist + edge_km
                if next_dist > max_km:
                    continue
                if next_dist < distances.get(neighbor_id, float("inf")):
                    distances[neighbor_id] = next_dist
                    previous[neighbor_id] = current_id
                    priority = next_dist + haversine_km(self.nodes[neighbor_id], goal)
                    heapq.heappush(heap, (priority, next_dist, neighbor_id))
        self.path_cache[cache_key] = None
        return None

    def sample_corridor(self, origin: dict[str, Any], destination: dict[str, Any], direct_km: float) -> dict[str, Any] | None:
        if not self.nodes:
            return None
        margin = min(2.5, max(0.4, direct_km / 250))
        min_lng = min(origin["lng"], destination["lng"]) - margin
        max_lng = max(origin["lng"], destination["lng"]) + margin
        min_lat = min(origin["lat"], destination["lat"]) - margin
        max_lat = max(origin["lat"], destination["lat"]) + margin
        min_x = math.floor(min_lng / self.lookup_cell_size)
        max_x = math.floor(max_lng / self.lookup_cell_size)
        min_y = math.floor(min_lat / self.lookup_cell_size)
        max_y = math.floor(max_lat / self.lookup_cell_size)
        candidates = []
        for x in range(min_x, max_x + 1):
            for y in range(min_y, max_y + 1):
                for node_id in self.lookup_cells.get((x, y), []):
                    node = self.nodes[node_id]
                    projection = project(origin, destination, node)
                    if projection < -0.04 or projection > 1.04:
                        continue
                    perpendicular = perpendicular_distance_km(origin, destination, node)
                    if perpendicular > max(25, min(95, direct_km * 0.28)):
                        continue
                    candidates.append({"lng": node["lng"], "lat": node["lat"], "projection": projection, "perpendicularKm": perpendicular})
        if len(candidates) < 5:
            return None
        candidates.sort(key=lambda item: item["projection"])
        sampled = sample_spaced(candidates, direct_km)
        if len(sampled) < 3:
            return None
        coordinates = [[origin["lng"], origin["lat"]], *[[point["lng"], point["lat"]] for point in sampled], [destination["lng"], destination["lat"]]]
        coordinates = prepare_segment_coordinates(coordinates, origin, destination, direct_km)
        return {
            "source": "oceanbase-12306-rail-corridor",
            "coordinates": coordinates,
            "distanceKm": haversine_km(origin, destination) * 1.12,
            "geometryDistanceKm": polyline_distance_km(coordinates),
        }


def rail_network_geometry(
    origin: dict[str, Any],
    destination: dict[str, Any],
    *,
    route_type: str,
    rail_network: RailNetwork,
) -> dict[str, Any] | None:
    if not rail_network.usable():
        return None
    direct_km = max(1.0, haversine_km(origin, destination))
    attach_km = 35 if direct_km > 800 else 26 if direct_km > 350 else 18
    origin_node = rail_network.station_anchor(origin, attach_km)
    destination_node = rail_network.station_anchor(destination, attach_km)
    if origin_node is not None and destination_node is not None and origin_node != destination_node:
        path = rail_network.shortest_path(origin_node, destination_node, direct_km)
        if path and path["distanceKm"] <= direct_km * 2.05 + 45:
            coordinates = [[origin["lng"], origin["lat"]]]
            coordinates.extend([rail_network.nodes[node_id]["lng"], rail_network.nodes[node_id]["lat"]] for node_id in path["nodes"])
            coordinates.append([destination["lng"], destination["lat"]])
            coordinates = prepare_segment_coordinates(coordinates, origin, destination, direct_km)
            return {
                "source": "oceanbase-12306-rail-graph",
                "coordinates": coordinates,
                "distanceKm": path["distanceKm"],
                "geometryDistanceKm": polyline_distance_km(coordinates),
            }
    return rail_network.sample_corridor(origin, destination, direct_km)


def parse_linestring(value: Any) -> list[list[float]]:
    try:
        geometry = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
        return []
    coordinates = geometry.get("coordinates")
    return coordinates if isinstance(coordinates, list) else []


def prepare_segment_coordinates(
    coordinates: list[list[float]],
    origin: dict[str, Any],
    destination: dict[str, Any],
    direct_km: float,
) -> list[list[float]]:
    coordinates = [[float(coord[0]), float(coord[1])] for coord in coordinates if valid_coord(coord)]
    if len(coordinates) < 2:
        return densified_edge(origin, destination, direct_km)
    coordinates[0] = [origin["lng"], origin["lat"]]
    coordinates[-1] = [destination["lng"], destination["lat"]]
    coordinates = remove_backtracking_hooks(coordinates)
    tolerance = 0.0035 if direct_km > 600 else 0.002 if direct_km > 250 else 0.0012 if direct_km > 100 else 0.0008
    max_points = 70 if direct_km > 800 else 55 if direct_km > 300 else 38
    simplified = simplify_douglas_peucker(coordinates, tolerance)
    capped = cap_vertex_count(simplified, max_points)
    capped = remove_backtracking_hooks(capped)
    repaired = repair_big_jumps(capped)
    return round_coordinates(repaired)


def simplify_douglas_peucker(coords: list[list[float]], tolerance: float) -> list[list[float]]:
    if len(coords) <= 2:
        return coords[:]
    keep = [False] * len(coords)
    keep[0] = True
    keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        start, end = stack.pop()
        if end - start <= 1:
            continue
        ax, ay = coords[start]
        bx, by = coords[end]
        dx = bx - ax
        dy = by - ay
        length_sq = dx * dx + dy * dy
        max_dist = 0.0
        max_index = -1
        for index in range(start + 1, end):
            px, py = coords[index]
            if length_sq == 0:
                perp = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
                perp = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if perp > max_dist:
                max_dist = perp
                max_index = index
        if max_dist > tolerance and max_index > 0:
            keep[max_index] = True
            stack.append((start, max_index))
            stack.append((max_index, end))
    return [coord for index, coord in enumerate(coords) if keep[index]]


def remove_backtracking_hooks(coords: list[list[float]]) -> list[list[float]]:
    cleaned = coords[:]
    for _ in range(100):
        changed = False
        for index in range(1, len(cleaned) - 1):
            previous = cleaned[index - 1]
            current = cleaned[index]
            following = cleaned[index + 1]
            first_km = haversine_coord_km(previous, current)
            second_km = haversine_coord_km(current, following)
            if min(first_km, second_km) < 2:
                continue
            bypass_km = haversine_coord_km(previous, following)
            turn = bearing_delta(previous, current, following)
            if turn > 145 and bypass_km < max(first_km, second_km) * 0.95:
                cleaned.pop(index)
                changed = True
                break
        if not changed:
            break
    return cleaned


def cap_vertex_count(coords: list[list[float]], max_vertices: int) -> list[list[float]]:
    if len(coords) <= max_vertices:
        return coords
    result = [coords[0]]
    step = (len(coords) - 1) / (max_vertices - 1)
    for index in range(1, max_vertices - 1):
        result.append(coords[round(index * step)])
    result.append(coords[-1])
    return result


def repair_big_jumps(coords: list[list[float]]) -> list[list[float]]:
    if len(coords) < 2:
        return coords
    max_jump_km = 88
    repaired = [coords[0]]
    for coord in coords[1:]:
        previous = repaired[-1]
        jump_km = haversine_coord_km(previous, coord)
        if jump_km > max_jump_km:
            steps = math.ceil(jump_km / max_jump_km)
            for step in range(1, steps):
                t = step / steps
                repaired.append([previous[0] + (coord[0] - previous[0]) * t, previous[1] + (coord[1] - previous[1]) * t])
        repaired.append(coord)
    return repaired


def round_coordinates(coords: list[list[float]]) -> list[list[float]]:
    rounded = []
    for lng, lat in coords:
        coord = [round(float(lng), 5), round(float(lat), 5)]
        if not rounded or coord != rounded[-1]:
            rounded.append(coord)
    return rounded


def polyline_distance_km(coords: list[list[float]]) -> float:
    return sum(haversine_coord_km(coords[index - 1], coords[index]) for index in range(1, len(coords)))


def haversine_coord_km(a: list[float], b: list[float]) -> float:
    return haversine_km({"lng": a[0], "lat": a[1]}, {"lng": b[0], "lat": b[1]})


def bearing_delta(previous: list[float], current: list[float], following: list[float]) -> float:
    first = bearing_degrees(previous, current)
    second = bearing_degrees(current, following)
    delta = abs(first - second) % 360
    return delta if delta <= 180 else 360 - delta


def bearing_degrees(a: list[float], b: list[float]) -> float:
    lat1 = math.radians(a[1])
    lat2 = math.radians(b[1])
    dlng = math.radians(b[0] - a[0])
    y = math.sin(dlng) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def project(origin: dict[str, Any], destination: dict[str, Any], point: dict[str, Any]) -> float:
    dx = destination["lng"] - origin["lng"]
    dy = destination["lat"] - origin["lat"]
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return 0
    return ((point["lng"] - origin["lng"]) * dx + (point["lat"] - origin["lat"]) * dy) / length_sq


def perpendicular_distance_km(origin: dict[str, Any], destination: dict[str, Any], point: dict[str, Any]) -> float:
    t = max(0.0, min(1.0, project(origin, destination, point)))
    projected = {
        "lng": origin["lng"] + (destination["lng"] - origin["lng"]) * t,
        "lat": origin["lat"] + (destination["lat"] - origin["lat"]) * t,
    }
    return haversine_km(projected, point)


def sample_spaced(candidates: list[dict[str, Any]], direct_km: float) -> list[dict[str, Any]]:
    min_spacing = 16 if direct_km > 400 else 9 if direct_km > 200 else 4.5
    filtered = []
    for point in candidates:
        previous = filtered[-1] if filtered else None
        if previous and haversine_km(previous, point) < min_spacing:
            continue
        if previous and point["projection"] - previous["projection"] < 0.005:
            continue
        filtered.append(point)
    max_points = 60 if direct_km > 600 else 46 if direct_km > 260 else 28
    if len(filtered) <= max_points:
        return filtered
    return [filtered[math.floor(index * (len(filtered) - 1) / (max_points - 1))] for index in range(max_points)]


def in_china_bounds(lng: float, lat: float) -> bool:
    min_lng, min_lat, max_lng, max_lat = CHINA_COORD_BOUNDS
    return min_lng <= lng <= max_lng and min_lat <= lat <= max_lat


def load_static_context() -> dict[str, Any]:
    stations_by_name: dict[str, dict[str, Any]] = {}
    segments_by_edge: dict[str, dict[str, Any]] = {}
    station_path = PUBLIC_DIR / "station-data.json"
    route_path = PUBLIC_DIR / "route-data.json"
    if station_path.exists():
        try:
            for station in json.loads(station_path.read_text(encoding="utf-8")).get("stations", []):
                stations_by_name.setdefault(station.get("name"), station)
        except (json.JSONDecodeError, OSError):
            pass
    if route_path.exists():
        try:
            route_data = json.loads(route_path.read_text(encoding="utf-8"))
            for route in route_data.get("routes", []):
                for segment in route.get("segments", []):
                    key = edge_key(segment.get("from"), segment.get("to"))
                    if key and key not in segments_by_edge and segment.get("geometry"):
                        segments_by_edge[key] = segment
        except (json.JSONDecodeError, OSError):
            pass
    return {"stationsByName": stations_by_name, "segmentsByEdge": segments_by_edge}


def build_segment(
    origin: dict[str, Any],
    destination: dict[str, Any],
    *,
    route_type: str,
    static_segments: dict[str, dict[str, Any]],
    rail_network: "RailNetwork",
) -> tuple[dict[str, Any], str]:
    distance = round(max(1.0, haversine_km(origin, destination) * 1.08), 1)
    rail_geometry = rail_network_geometry(origin, destination, route_type=route_type, rail_network=rail_network)
    if rail_geometry:
        return (
            {
                "from": origin["name"],
                "to": destination["name"],
                "distanceKm": round(max(1.0, rail_geometry["distanceKm"]), 1),
                "speedLimitKmh": speed_limit(route_type, distance),
                "track": "double" if route_type in {"G", "D", "C"} else "mixed",
                "signaling": "CTCS-3" if route_type in {"G", "D", "C"} else "CTCS simulated",
                "geometry": rail_geometry["coordinates"],
                "geometrySource": rail_geometry["source"],
                "geometryDistanceKm": round(max(1.0, rail_geometry["geometryDistanceKm"]), 1),
            },
            "rail-graph" if rail_geometry["source"].endswith("rail-graph") else "rail-corridor",
        )

    key = edge_key(origin["name"], destination["name"])
    reverse_key = edge_key(destination["name"], origin["name"])
    matched_segment = static_segments.get(key)
    reversed_match = False
    if not matched_segment and reverse_key in static_segments:
        matched_segment = static_segments[reverse_key]
        reversed_match = True

    if matched_segment:
        geometry = [coord[:] for coord in matched_segment.get("geometry", []) if valid_coord(coord)]
        if reversed_match:
            geometry.reverse()
        geometry = anchor_geometry(geometry, origin, destination)
        source = f"oceanbase-12306+{matched_segment.get('geometrySource', 'generated-rail')}"
        geometry_distance = matched_segment.get("geometryDistanceKm") or distance
        return (
            {
                "from": origin["name"],
                "to": destination["name"],
                "distanceKm": distance,
                "speedLimitKmh": speed_limit(route_type, distance),
                "track": "double",
                "signaling": "CTCS-3" if route_type in {"G", "D", "C"} else "CTCS simulated",
                "geometry": geometry,
                "geometrySource": source,
                "geometryDistanceKm": round(float(geometry_distance), 1),
            },
            "static",
        )

    geometry = densified_edge(origin, destination, distance)
    return (
        {
            "from": origin["name"],
            "to": destination["name"],
            "distanceKm": distance,
            "speedLimitKmh": speed_limit(route_type, distance),
            "track": "double" if route_type in {"G", "D", "C"} else "mixed",
            "signaling": "CTCS-3" if route_type in {"G", "D", "C"} else "CTCS simulated",
            "geometry": geometry,
            "geometrySource": "oceanbase-12306-ordered-stop-edge",
            "geometryDistanceKm": distance,
        },
        "fallback",
    )


def build_route_contract(route_id: int, route_code: str, stops: list[dict[str, Any]]) -> dict[str, Any]:
    route_key = f"ob12306-route-{route_id}-{safe_slug(route_code)}"
    stop_sequence = [stop["name"] for stop in stops]
    return {
        "version": 1,
        "routeId": route_key,
        "outboundVariantId": f"{route_key}:outbound",
        "returnVariantId": f"{route_key}:return",
        "stopSequence": stop_sequence,
        "returnStopSequence": list(reversed(stop_sequence)),
        "stopSequenceHash": stable_hash("\0".join(stop_sequence)),
        "source": "OceanBase cr_12306_route_stations",
    }


def merge_segment_geometry(segments: list[dict[str, Any]]) -> list[list[float]]:
    merged: list[list[float]] = []
    for segment in segments:
        coords = segment.get("geometry") or []
        if not coords:
            continue
        merged.extend(coords if not merged else coords[1:])
    return merged


def densified_edge(origin: dict[str, Any], destination: dict[str, Any], distance_km: float) -> list[list[float]]:
    steps = max(1, min(12, math.ceil(distance_km / 55)))
    coords = []
    for index in range(steps + 1):
        t = index / steps
        lng = origin["lng"] + (destination["lng"] - origin["lng"]) * t
        lat = origin["lat"] + (destination["lat"] - origin["lat"]) * t
        coords.append([round(lng, 5), round(lat, 5)])
    return coords


def anchor_geometry(geometry: list[list[float]], origin: dict[str, Any], destination: dict[str, Any]) -> list[list[float]]:
    if not geometry:
        return densified_edge(origin, destination, haversine_km(origin, destination))
    geometry[0] = [round(origin["lng"], 5), round(origin["lat"], 5)]
    geometry[-1] = [round(destination["lng"], 5), round(destination["lat"], 5)]
    return geometry


def infer_train_type(route_row: dict[str, Any]) -> str:
    code = str(route_row.get("train_code") or route_row.get("train_no") or "").strip().upper()
    if code and code[0] in {"G", "D", "C", "Z", "T", "K"}:
        return code[0]
    class_name = str(route_row.get("train_class_name") or "")
    if "高速" in class_name:
        return "G"
    if "动车" in class_name:
        return "D"
    if "城际" in class_name:
        return "C"
    if "直" in class_name:
        return "Z"
    if "特" in class_name:
        return "T"
    if "快速" in class_name:
        return "K"
    return "R"


def route_frequency_rank(route_type: str, stop_count: int) -> float:
    base = {"G": 0.78, "D": 0.62, "C": 0.58, "Z": 0.34, "T": 0.28, "K": 0.2}.get(route_type, 0.18)
    stop_adjustment = min(0.16, max(0, stop_count - 4) * 0.008)
    return round(min(0.96, base + stop_adjustment), 4)


def dwell_minutes(stop_row: dict[str, Any], *, index: int, total: int, station: dict[str, Any]) -> int:
    if index in {0, total - 1}:
        return 6 if station.get("tier") == "national-hub" else 4
    arrive = minutes_from_clock(stop_row.get("arrive_time"))
    depart = minutes_from_clock(stop_row.get("start_time"))
    if arrive is not None and depart is not None:
        diff = depart - arrive
        if diff < 0:
            diff += 1440
        if 1 <= diff <= 15:
            return diff
    return 5 if station.get("tier") == "national-hub" else 3


def speed_limit(route_type: str, distance: float) -> int:
    if route_type == "G":
        return 300 if distance >= 70 else 250
    if route_type in {"D", "C"}:
        return 250 if distance >= 50 else 200
    if route_type in {"Z", "T"}:
        return 160
    return 120


def tier_for_name(name: str) -> str:
    if name in NATIONAL_HUB_NAMES:
        return "national-hub"
    if name.endswith(("南", "北", "东", "西")):
        return "regional-hub"
    return "local"


def haversine_km(a: dict[str, Any], b: dict[str, Any]) -> float:
    radius = 6371.0088
    lat1 = math.radians(float(a["lat"]))
    lat2 = math.radians(float(b["lat"]))
    dlat = lat2 - lat1
    dlng = math.radians(float(b["lng"]) - float(a["lng"]))
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


def minutes_from_clock(value: Any) -> int | None:
    text = normalize_time(value)
    if not text:
        return None
    hour, minute = text.split(":")
    return int(hour) * 60 + int(minute)


def normalize_time(value: Any) -> str | None:
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{2}:\d{2}", text):
        return None
    return text


def edge_key(origin: Any, destination: Any) -> str:
    if not origin or not destination:
        return ""
    return f"{origin}|{destination}"


def q(identifier: str, dialect: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", identifier):
        raise SystemExit(f"Unsafe SQL identifier: {identifier}")
    quote = '"' if dialect == "sqlite" else "`"
    return f"{quote}{identifier}{quote}"


def validate_prefix(prefix: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", prefix):
        raise SystemExit("--table-prefix must be a SQL identifier prefix")
    return prefix


def safe_slug(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", str(value or "route")).strip("-") or "route"


def stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def valid_coord(coord: Any) -> bool:
    return isinstance(coord, list) and len(coord) >= 2 and as_float(coord[0]) is not None and as_float(coord[1]) is not None


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
