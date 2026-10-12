"""
RideSync project 2, step 4 - postgres seeder.

Generates:
  - riders, vehicles (base data)
  - >= 50,000 trips
  - >= 100,000 wallet_audit_logs rows -- NOT inserted directly (that table is
    insert-only via the step-2 trigger). Instead this script performs real
    UPDATEs on riders.wallet_balance and lets trg_wallet_audit_log write the
    audit rows, same as the app would:
        - trip bookings   -> wallet_balance decreases, tagged ESCROW
                             (via SET LOCAL ridesync.wallet_action_type, same
                             convention sql/04_stored_procedures.sql uses)
        - wallet top-ups  -> wallet_balance increases, trigger infers CREDIT
        - misc debits     -> wallet_balance decreases (no escrow flag),
                             trigger infers DEBIT
  This naturally exercises all three action_type values.

Constraints respected:
  - riders.wallet_balance CHECK >= 0            -> balance tracked in python,
                                                    never let deltas go negative
  - idx_active_rider_trip (sql/02_indexes.sql)  -> at most one rider trip in
                                                    REQUESTED/IN_TRANSIT at a time,
                                                    tracked in python before insert

Run:
    python data_generation/postgres_seeder.py            # adds to whatever is there
    python data_generation/postgres_seeder.py --reset    # TRUNCATE the 4 tables first

Env vars (all optional, defaults match the docker command in the README):
    PGHOST=localhost  PGPORT=5432  PGDATABASE=ridesync
    PGUSER=postgres   PGPASSWORD=ridesync
    RIDESYNC_QUICK_SEED=1   -> shrinks all counts ~100x, for a fast local smoke test
"""

import os
import sys
import uuid
import random
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

import psycopg2
from psycopg2.extras import execute_values
from faker import Faker

fake = Faker()

QUICK = os.environ.get("RIDESYNC_QUICK_SEED") == "1"

NUM_RIDERS = 3_000 if not QUICK else 100
NUM_VEHICLES = 500 if not QUICK else 30
NUM_TRIPS = 50_000 if not QUICK else 600
NUM_TOPUPS = 55_000 if not QUICK else 600
NUM_MISC_DEBITS = 5_000 if not QUICK else 60
# -> total wallet_audit_logs rows = NUM_TRIPS + NUM_TOPUPS + NUM_MISC_DEBITS
#    (50k + 55k + 5k = 110k, comfortably over the 100k requirement)

BATCH_SIZE = 2_000
VEHICLE_CLASSES = ["MINI", "SEDAN", "SUV", "XL"]
TRIP_DAYS_BACK = 45  # spread trip created_at over 45 days so the 7-day moving
                      # average query (sql/06_window_analytics.sql) has more
                      # than one window's worth of data to chew on

OUT_DIR = os.path.join(os.path.dirname(__file__), "generated_ids")
OUT_PATH = os.path.join(OUT_DIR, "ids.json")


def db_connect():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        port=os.environ.get("PGPORT", "5432"),
        dbname=os.environ.get("PGDATABASE", "ridesync"),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "ridesync"),
    )


def money(x):
    return Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def seed_riders(conn):
    riders = []
    for _ in range(NUM_RIDERS):
        riders.append((str(uuid.uuid4()), fake.name(), money(random.uniform(500, 5000))))

    with conn.cursor() as cur:
        execute_values(
            cur,
            "INSERT INTO riders (id, name, wallet_balance) VALUES %s",
            riders,
        )
    conn.commit()
    print(f"seeded {len(riders)} riders")
    # id -> running balance, tracked in python so we never violate the CHECK
    # constraint or have to guess-and-retry against the db
    return {r[0]: r[2] for r in riders}


def seed_vehicles(conn):
    vehicles = []
    seen_plates = set()
    while len(vehicles) < NUM_VEHICLES:
        plate = fake.unique.license_plate()
        if plate in seen_plates:
            continue
        seen_plates.add(plate)
        vehicles.append(
            (
                str(uuid.uuid4()),
                plate,
                random.choice(VEHICLE_CLASSES),
                random.random() > 0.05,  # ~95% active
            )
        )

    with conn.cursor() as cur:
        execute_values(
            cur,
            "INSERT INTO vehicles (id, license_plate, class, is_active) VALUES %s",
            vehicles,
        )
    conn.commit()
    print(f"seeded {len(vehicles)} vehicles")
    return [v[0] for v in vehicles], [v[0] for v in vehicles if v[3]]


def bulk_wallet_delta(cur, deltas, escrow=False):
    """Apply many (rider_id, delta) wallet_balance changes in one statement.
    Each row still fires trg_wallet_audit_log individually (FOR EACH ROW), so
    this is just a fast way to generate lots of audit rows, not a shortcut
    that skips the trigger.
    """
    if not deltas:
        return
    if escrow:
        cur.execute("SET LOCAL ridesync.wallet_action_type = 'ESCROW'")

    # UPDATE ... FROM (VALUES ...) updates each target row at most once per
    # statement: if the same rider appears twice in one VALUES list, postgres
    # applies one of the deltas and silently drops the other (no audit row, and
    # the db balance drifts away from the one tracked in python). So split the
    # batch into rounds in which every rider appears at most once, keeping each
    # rider's deltas in their original order.
    rounds = []
    seen_count = {}
    for rid, delta in deltas:
        n = seen_count.get(rid, 0)
        seen_count[rid] = n + 1
        if n == len(rounds):
            rounds.append([])
        rounds[n].append((rid, str(delta)))

    for rows in rounds:
        execute_values(
            cur,
            """
            UPDATE riders AS r
            SET wallet_balance = r.wallet_balance + v.delta::numeric
            FROM (VALUES %s) AS v(rider_id, delta)
            WHERE r.id = v.rider_id::uuid
            """,
            rows,
            page_size=len(rows),
        )


def random_created_at():
    days_back = random.uniform(0, TRIP_DAYS_BACK)
    return datetime.now(timezone.utc) - timedelta(days=days_back)


def seed_trips_and_escrow(conn, rider_ids, rider_balance, vehicle_ids, active_vehicle_ids):
    """Books NUM_TRIPS trips in batches. Each trip debits the rider's wallet
    (tagged ESCROW) in the same batch transaction the trip row is inserted in,
    mirroring what sql/04_stored_procedures.sql:book_trip does for a single
    booking, just batched for seeding speed.
    """
    rider_active_trip = {}  # rider_id -> True while it has a REQUESTED/IN_TRANSIT trip
    trip_records = []  # collected for the ids.json export (mongo needs these)

    batch_trips = []
    batch_deltas = []
    inserted = 0

    def flush(cur):
        nonlocal batch_trips, batch_deltas
        if not batch_trips:
            return
        bulk_wallet_delta(cur, batch_deltas, escrow=True)
        execute_values(
            cur,
            """
            INSERT INTO trips (id, rider_id, vehicle_id, fare_amount, status, created_at)
            VALUES %s
            """,
            batch_trips,
        )
        batch_trips = []
        batch_deltas = []

    with conn.cursor() as cur:
        # loop until the target is reached (not a fixed NUM_TRIPS attempts), so the
        # rare skipped attempt below can't leave us one short of 50,000
        while inserted < NUM_TRIPS:
            # pick a rider that can actually take a new active trip if we roll
            # REQUESTED/IN_TRANSIT; for COMPLETED it doesn't matter
            rider_id = random.choice(rider_ids)

            roll = random.random()
            if roll < 0.85 or rider_active_trip.get(rider_id):
                status = "COMPLETED"
            elif roll < 0.925:
                status = "REQUESTED"
            else:
                status = "IN_TRANSIT"

            fare = money(random.uniform(50, 600))
            balance = rider_balance[rider_id]
            if fare > balance:
                # rider can't afford it -- scale the fare down instead of
                # skipping, so we don't waste the pre-picked rider/vehicle
                fare = money(max(Decimal("10.00"), balance * Decimal(random.uniform(0.1, 0.5))))
                if fare > balance:
                    continue  # near-zero balance, just skip this one

            trip_id = str(uuid.uuid4())
            # a trip that is still open has to be on a vehicle that is in the fleet;
            # completed trips can be on a vehicle that was deactivated later
            if status == "COMPLETED":
                vehicle_id = random.choice(vehicle_ids)
            else:
                vehicle_id = random.choice(active_vehicle_ids)
            created_at = random_created_at()

            rider_balance[rider_id] = balance - fare
            if status in ("REQUESTED", "IN_TRANSIT"):
                rider_active_trip[rider_id] = True

            batch_trips.append((trip_id, rider_id, vehicle_id, str(fare), status, created_at))
            batch_deltas.append((rider_id, -fare))
            trip_records.append(
                {
                    "trip_id": trip_id,
                    "rider_id": rider_id,
                    "vehicle_id": vehicle_id,
                    "status": status,
                    "created_at": created_at.isoformat(),
                }
            )
            inserted += 1

            if len(batch_trips) >= BATCH_SIZE:
                flush(cur)
                conn.commit()
                print(f"  trips booked: {inserted}/{NUM_TRIPS}")

        flush(cur)
        conn.commit()

    print(f"seeded {inserted} trips (target {NUM_TRIPS})")
    return trip_records


def seed_topups(conn, rider_ids, rider_balance):
    batch = []
    with conn.cursor() as cur:
        for i in range(NUM_TOPUPS):
            rider_id = random.choice(rider_ids)
            amount = money(random.uniform(100, 1500))
            rider_balance[rider_id] += amount
            batch.append((rider_id, amount))

            if len(batch) >= BATCH_SIZE:
                bulk_wallet_delta(cur, batch, escrow=False)  # delta > 0 -> CREDIT
                conn.commit()
                batch = []
                print(f"  top-ups applied: {i + 1}/{NUM_TOPUPS}")

        if batch:
            bulk_wallet_delta(cur, batch, escrow=False)
            conn.commit()

    print(f"seeded {NUM_TOPUPS} wallet top-ups (CREDIT)")


def seed_misc_debits(conn, rider_ids, rider_balance):
    batch = []
    applied = 0
    with conn.cursor() as cur:
        for _ in range(NUM_MISC_DEBITS):
            rider_id = random.choice(rider_ids)
            balance = rider_balance[rider_id]
            amount = money(min(float(balance), random.uniform(20, 200)))
            if amount <= 0:
                continue
            rider_balance[rider_id] = balance - amount
            batch.append((rider_id, -amount))
            applied += 1

            if len(batch) >= BATCH_SIZE:
                bulk_wallet_delta(cur, batch, escrow=False)  # delta < 0, no flag -> DEBIT
                conn.commit()
                batch = []

        if batch:
            bulk_wallet_delta(cur, batch, escrow=False)
            conn.commit()

    print(f"seeded {applied} misc debits (DEBIT)")


def reset_tables(conn):
    # TRUNCATE is not blocked by the append-only trigger on wallet_audit_logs
    # (that one is row-level, UPDATE/DELETE only), so this is the supported way
    # to start over.
    with conn.cursor() as cur:
        cur.execute("TRUNCATE wallet_audit_logs, trips, riders, vehicles")
    conn.commit()
    print("truncated riders, vehicles, trips, wallet_audit_logs")


def analyze_tables(conn):
    # fresh planner stats, otherwise the first queries after a bulk load are
    # planned as if the tables were still empty
    with conn.cursor() as cur:
        cur.execute("ANALYZE riders, vehicles, trips, wallet_audit_logs")
    conn.commit()
    print("analyzed tables")


def refresh_materialized_view(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT refresh_vehicle_trip_stats();")
    conn.commit()
    print("refreshed mv_vehicle_trip_stats")


def export_ids_for_mongo(rider_ids, vehicle_ids, trip_records):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(
            {"rider_ids": rider_ids, "vehicle_ids": vehicle_ids, "trips": trip_records},
            f,
        )
    print(f"wrote id map for mongo_seeder.py -> {OUT_PATH}")


def main():
    conn = db_connect()
    try:
        if "--reset" in sys.argv[1:]:
            reset_tables(conn)

        rider_balance = seed_riders(conn)
        rider_ids = list(rider_balance.keys())
        vehicle_ids, active_vehicle_ids = seed_vehicles(conn)

        # top-ups go first: 50k trips cost more than the riders' opening
        # balances add up to, so booking before topping up left ~25% of the
        # trips unaffordable and they were skipped.
        seed_topups(conn, rider_ids, rider_balance)
        trip_records = seed_trips_and_escrow(
            conn, rider_ids, rider_balance, vehicle_ids, active_vehicle_ids
        )
        seed_misc_debits(conn, rider_ids, rider_balance)

        analyze_tables(conn)
        refresh_materialized_view(conn)
        export_ids_for_mongo(rider_ids, vehicle_ids, trip_records)

        total_audit_rows = NUM_TRIPS + NUM_TOPUPS + NUM_MISC_DEBITS
        print(f"done. wallet_audit_logs should have ~{total_audit_rows} rows "
              f"(exact count may be slightly lower if some near-zero-balance "
              f"riders were skipped).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()