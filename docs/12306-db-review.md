# 12306 SQLite Review and OceanBase Migration Notes

**Review date:** 2026-05-13
**Source database:** `/Users/rogerlin/Downloads/chinashsr/12306.db`
**Review command:** `python3 scripts/migrate_12306_to_oceanbase.py --sqlite /Users/rogerlin/Downloads/chinashsr/12306.db --output-dir /tmp/chinahsr-12306-review`

## Executive Summary

The `12306.db` snapshot is a strong fit for improving the route-following layer of the simulation. It contains an internally consistent station table, ordered route-stop timetable rows, ticket/price rows, station coordinates, OSM rail geometries, and station-to-track links. The most important finding for the oscillation/shortcut problem is that all 388 train routes have ordered `route_stations` records with no duplicate station orders, no missing first stop, and no order gaps. That makes this database useful as an authoritative stop-sequence source instead of inferring movement from origin/destination pairs.

This database is not a full live 12306 mirror. It is a dated snapshot: train route departures span 2026-05-11 through 2026-05-18, ticket query rows are from 2026-05-12, and ticket coverage is partial. It should be used to harden route contracts, station matching, geometry snapping, and fare calibration, while live inventory should remain simulated unless a real authorized feed is added.

## Source Integrity and Size

| Check | Result |
|---|---:|
| SQLite integrity check | `ok` |
| File size | 62,337,024 bytes |
| SQLite page size | 4,096 bytes |
| SQLite page count | 15,219 |
| User tables | 8 |
| Total rows across reviewed tables | 255,938 |

The first direct metadata read encountered a transient lock, so the final review opens the database through SQLite's read-only immutable URI mode. That keeps the migration tool from taking write locks or depending on local GUI state.

## Table Inventory

| Table | Rows | Role in Simulation |
|---|---:|---|
| `stations` | 3,365 | Station codes, names, pinyin, city metadata. |
| `train_routes` | 388 | Train-level route headers by train number and departure date. |
| `route_stations` | 4,760 | Ordered stop sequence and arrival/departure times for each route. |
| `tickets` | 331 | Queried OD ticket records with station telecodes. |
| `ticket_prices` | 1,271 | Seat-class fare rows tied to tickets. |
| `railway_tracks` | 226,613 | OSM-derived rail LineString geometries. |
| `station_locations` | 3,345 | Station coordinates linked to station codes. |
| `station_track_links` | 15,865 | Station-to-rail-track associations. |

## Route and Stop-Sequence Quality

| Metric | Result |
|---|---:|
| Routes with stops | 388 / 388 |
| Stops per route, min / median / max | 2 / 11 / 38 |
| Average stops per route | 12.27 |
| Routes with duplicate station order | 0 |
| Routes whose first station order is not 1 | 0 |
| Routes with stop-order gaps | 0 |
| Distinct route station names | 874 |
| Route station names unmatched in `stations` by name | 0 |

These invariants directly address the previous train oscillation failure mode. A train should move through the ordered `route_stations` list for its route, then reverse that same ordered list after reaching the terminal. The simulation should never choose the next station by nearest neighbor or by raw origin/destination lookup when an ordered route contract is available.

## Referential Quality

| Check | Result |
|---|---:|
| `ticket_prices.ticket_id` without matching ticket | 0 |
| `station_locations.station_code` without matching station | 0 |
| `station_track_links.station_code` without matching station | 0 |
| `station_track_links.track_id` without matching rail track | 0 |
| Ticket `from_station_telecode` missing in stations | 0 |
| Ticket `to_station_telecode` missing in stations | 0 |
| Train route rows without a same-`train_no` ticket row | 149 |
| Ticket rows without a same-`train_no` route row | 3 |

The data is clean enough for route geometry and station sequence work. The ticket tables are useful for fare calibration, but they should not be interpreted as complete coverage for every route in the timetable snapshot.

## Station and Geometry Quality

| Metric | Result |
|---|---:|
| Station locations | 3,345 |
| Distinct station codes with locations | 3,232 |
| Plausible China coordinate rows | 3,345 / 3,345 |
| `stations` rows with at least one location | 3,232 / 3,365 |
| Railway geometry parse errors | 0 |
| Railway geometry types | 226,613 `LineString` records |
| Points per rail geometry, min / median / p95 / max | 2 / 2 / 23 / 1,579 |
| Coordinate range | lon 75.9659 to 134.5111, lat 18.2916 to 53.0039 |

The OSM rail table is much larger than the route table and is best used as a geometry-snapping substrate. The existing simulation should still retain its generated `route_variant_geometry` tables for fast runtime movement, but the `12306.db` track tables can enrich or audit those generated geometries.

## OceanBase Target Schema

The migration script writes a MySQL/OceanBase-compatible schema using the prefix `cr_12306_` so it does not collide with the simulation's generated tables (`stations`, `routes`, `route_variants`, `daily_route_services`, `bookings`, and related tables).

Generated target tables:

| Source | OceanBase target |
|---|---|
| `stations` | `cr_12306_stations` |
| `train_routes` | `cr_12306_train_routes` |
| `route_stations` | `cr_12306_route_stations` |
| `tickets` | `cr_12306_tickets` |
| `ticket_prices` | `cr_12306_ticket_prices` |
| `railway_tracks` | `cr_12306_railway_tracks` |
| `station_locations` | `cr_12306_station_locations` |
| `station_track_links` | `cr_12306_station_track_links` |

Generated query views:

| View | Purpose |
|---|---|
| `cr_12306_route_stop_sequences` | One row per route with origin, terminal, stop count, and ordered stop sequence. |
| `cr_12306_route_edges` | Consecutive station-to-station edges for route-following and validation. |
| `cr_12306_ticket_route_coverage` | Ticket rows left-joined to matching route headers by train number. |

## Commands

Review without touching OceanBase:

```bash
npm run 12306:review
```

Load into a reachable OceanBase MySQL-mode tenant:

```bash
export OB_HOST=127.0.0.1
export OB_PORT=2881
export OB_USER=root
export OB_DATABASE=chinahsr
export OB_PASSWORD='your-oceanbase-password'

npm run 12306:migrate -- \
  --sqlite /Users/rogerlin/Downloads/chinashsr/12306.db \
  --create-database \
  --truncate
```

For the Tencent CVM, prefer an SSH tunnel instead of opening OceanBase to the public Internet:

```bash
ssh -N -L 2881:127.0.0.1:2881 <user>@43.160.208.85
OB_HOST=127.0.0.1 OB_PORT=2881 npm run 12306:migrate -- --create-database --truncate
```

## Simulation Integration Recommendation

1. Use `cr_12306_route_stop_sequences` and `cr_12306_route_edges` as the authoritative timetable route contract when a train number/departure date is present.
2. Convert each ordered stop list into outbound and return route variants, matching the already implemented terminal turnaround behavior.
3. Use `station_locations` for station coordinates and `station_track_links` plus `railway_tracks` for geometry validation/snap-to-rail enrichment.
4. Use `tickets` and `ticket_prices` to calibrate OD fares by train class and seat class, not as a complete live inventory feed.
5. Keep the current generated simulation tables for annual route-day aggregates and booking ledgers; the `cr_12306_` tables should complement them as source-of-truth reference data.
