#!/usr/bin/env python3
"""Bulk-ingest a JSON Lines booking ledger into OceanBase.

Usage:
    OB_PASSWORD=... python3 scripts/oceanbase_booking_ingest.py \
        --input bookings.ndjson \
        [--run-id yearly-...] [--batch-size 500]

Each input line is a JSON object emitted by the browser worker (or any other
producer). A small flusher in `serve-static.cjs` POSTs `bookings.ndjson` here
so we never serialize one INSERT per booking.

The file is delete-after-load by default to avoid double-inserts.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, help='NDJSON file with one booking per line')
    parser.add_argument('--run-id', default='live-browser')
    parser.add_argument('--batch-size', type=int, default=500)
    parser.add_argument('--keep-input', action='store_true', help='Do not delete the input file after load')
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    if not input_path.exists():
        raise SystemExit(f'Input file not found: {input_path}')

    rows: list[tuple[Any, ...]] = []
    with input_path.open('r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                booking = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f'  warning: skipping invalid JSON line: {exc}', file=sys.stderr)
                continue
            rows.append(booking_to_row(booking, args.run_id))

    if not rows:
        print('[oceanbase:booking-ingest] no rows to ingest')
        return 0

    password = os.environ.get('OB_PASSWORD')
    if not password:
        raise SystemExit('OB_PASSWORD is required for booking ingestion.')

    try:
        import pymysql
    except ImportError as exc:
        raise SystemExit('PyMySQL is required: python3 -m pip install PyMySQL') from exc

    conn = pymysql.connect(
        host=os.environ.get('OB_HOST', '127.0.0.1'),
        port=int(os.environ.get('OB_PORT', '2881')),
        user=os.environ.get('OB_USER', 'root'),
        password=password,
        database=os.environ.get('OB_DATABASE', 'chinahsr'),
        charset='utf8mb4',
        autocommit=False,
    )

    sql = """
    INSERT INTO bookings (
      ticket_id, run_id, train_id, train_code, route_id, passenger_id, passenger_name,
      origin_station, destination_station, origin_index, destination_index,
      seat_class, seat_count, seats_json, price, distance_km,
      booked_at_minute, booked_at_clock, service_date, status, no_show
    ) VALUES (
      %s, %s, %s, %s, %s, %s, %s,
      %s, %s, %s, %s,
      %s, %s, %s, %s, %s,
      %s, %s, %s, %s, %s
    ) ON DUPLICATE KEY UPDATE
      status=VALUES(status), no_show=VALUES(no_show),
      seats_json=VALUES(seats_json), price=VALUES(price)
    """

    inserted = 0
    with conn.cursor() as cursor:
        for start in range(0, len(rows), args.batch_size):
            chunk = rows[start:start + args.batch_size]
            cursor.executemany(sql, chunk)
            conn.commit()
            inserted += len(chunk)
    conn.close()

    if not args.keep_input:
        input_path.unlink(missing_ok=True)

    print(f'[oceanbase:booking-ingest] inserted/upserted {inserted} bookings from {input_path.name}')
    return 0


def booking_to_row(booking: dict[str, Any], run_id: str) -> tuple[Any, ...]:
    seats = booking.get('seats') or []
    return (
        booking.get('ticketId'),
        booking.get('runId') or run_id,
        booking.get('trainId'),
        booking.get('trainCode'),
        booking.get('routeId'),
        booking.get('passengerId'),
        booking.get('passengerName'),
        booking.get('origin'),
        booking.get('destination'),
        booking.get('originIndex'),
        booking.get('destinationIndex'),
        booking.get('seatClass'),
        len(seats),
        json.dumps(seats, ensure_ascii=False, separators=(',', ':'))[:500],
        float(booking.get('price') or 0),
        int(booking.get('distanceKm') or 0),
        int(booking.get('bookedAtMinute') or 0),
        booking.get('bookedAtClock') or '',
        booking.get('serviceDate'),
        booking.get('status') or 'confirmed',
        1 if booking.get('noShow') else 0,
    )


if __name__ == '__main__':
    raise SystemExit(main())
