"""
RideSync project 2, step 4 - mongo seeder.

Generates:
  - VehicleMetadata: one doc per vehicle from postgres_seeder.py's output
  - TripReviews: a review for a sample of COMPLETED trips
  - TelemetryPings: >= 500,000 pings, spread across all vehicles

Must run AFTER postgres_seeder.py -- it reads
data_generation/generated_ids/ids.json (rider/vehicle/trip UUIDs) so that
vehicle_id / trip_id / rider_id here match real postgres rows, per the
"same ids as postgres, as strings" convention in docs/mongo_schema_map.json.
That file is generated data, not checked into git (see .gitignore).

TelemetryPings.created_at is deliberately kept within the last ~90 minutes,
comfortably inside the 2-hour TTL (mongo/01_collections_and_indexes.js) --
pings older than that would just get reaped by the TTL monitor before anyone
could query them, which defeats the point of seeding them.

Run:
    python data_generation/mongo_seeder.py            # adds to whatever is there
    python data_generation/mongo_seeder.py --reset    # empty the 3 collections first

Env vars:
    MONGO_URI=mongodb://localhost:27017   MONGO_DB=ridesync
    RIDESYNC_QUICK_SEED=1   -> shrinks ping count for a fast local smoke test
"""

import os
import sys
import json
import random
from datetime import datetime, timedelta, timezone

from pymongo import MongoClient, InsertOne
from faker import Faker

fake = Faker()

QUICK = os.environ.get("RIDESYNC_QUICK_SEED") == "1"

NUM_PINGS = 520_000 if not QUICK else 5_000
REVIEW_RATE = 0.6  # fraction of COMPLETED trips that get a review
PING_BATCH_SIZE = 5_000

# same Hyderabad bounding box used in mongo/02_workflow3_geonear.js and the README
LNG_RANGE = (78.30, 78.60)
LAT_RANGE = (17.30, 17.50)

FEATURE_POOL = ["AC", "wifi", "music_system", "child_seat", "phone_charger", "sunroof"]
REVIEW_TAGS = ["clean", "on_time", "rude_driver", "smooth_ride", "late", "friendly", "safe_driving"]

IDS_PATH = os.path.join(os.path.dirname(__file__), "generated_ids", "ids.json")


def load_ids():
    if not os.path.exists(IDS_PATH):
        raise SystemExit(
            f"{IDS_PATH} not found -- run data_generation/postgres_seeder.py first, "
            f"it writes the vehicle/trip/rider ids this script needs."
        )
    with open(IDS_PATH) as f:
        return json.load(f)


def get_db():
    client = MongoClient(os.environ.get("MONGO_URI", "mongodb://localhost:27017"))
    return client[os.environ.get("MONGO_DB", "ridesync")]


def seed_vehicle_metadata(db, vehicle_ids):
    docs = []
    for vehicle_id in vehicle_ids:
        docs.append(
            {
                "vehicle_id": vehicle_id,
                "make": fake.random_element(["Toyota", "Maruti", "Hyundai", "Honda", "Tata", "Mahindra"]),
                "model": fake.word().capitalize(),
                "year": random.randint(2016, 2026),
                "color": fake.color_name(),
                "features": random.sample(FEATURE_POOL, k=random.randint(1, 4)),
                "dynamic_features": {
                    "fuel_type": random.choice(["PETROL", "DIESEL", "CNG", "EV"]),
                    "seat_count": random.choice([4, 6, 7]),
                },
                "inspections": [
                    {
                        "inspected_at": (
                            datetime.now(timezone.utc) - timedelta(days=random.randint(1, 300))
                        ),
                        "passed": random.random() > 0.05,
                        "inspector": f"RTO {fake.city()}",
                        "notes": fake.sentence(nb_words=6),
                    }
                    for _ in range(random.randint(1, 3))
                ],
            }
        )

    if docs:
        db.VehicleMetadata.insert_many(docs, ordered=False)
    print(f"seeded {len(docs)} VehicleMetadata docs")


def seed_trip_reviews(db, trips):
    completed = [t for t in trips if t["status"] == "COMPLETED"]
    sample = random.sample(completed, k=int(len(completed) * REVIEW_RATE)) if completed else []

    docs = []
    for trip in sample:
        trip_created = datetime.fromisoformat(trip["created_at"])
        docs.append(
            {
                "trip_id": trip["trip_id"],
                "rider_id": trip["rider_id"],
                "vehicle_id": trip["vehicle_id"],
                "rating": random.choices([1, 2, 3, 4, 5], weights=[2, 3, 10, 35, 50])[0],
                "tags": random.sample(REVIEW_TAGS, k=random.randint(1, 3)),
                "comment": fake.sentence(nb_words=10),
                "created_at": trip_created + timedelta(minutes=random.randint(5, 120)),
            }
        )

    if docs:
        db.TripReviews.insert_many(docs, ordered=False)
    print(f"seeded {len(docs)} TripReviews docs ({len(completed)} completed trips available)")


def seed_telemetry_pings(db, vehicle_ids):
    now = datetime.now(timezone.utc)
    total = 0
    batch = []

    for i in range(NUM_PINGS):
        vehicle_id = random.choice(vehicle_ids)
        # keep pings well inside the 2-hour TTL window (mongo/01_collections_and_indexes.js)
        age = timedelta(minutes=random.uniform(0, 90))
        batch.append(
            InsertOne(
                {
                    "vehicle_id": vehicle_id,
                    "location": {
                        "type": "Point",
                        "coordinates": [
                            round(random.uniform(*LNG_RANGE), 6),
                            round(random.uniform(*LAT_RANGE), 6),
                        ],
                    },
                    "is_available": random.random() < 0.4,
                    "created_at": now - age,
                }
            )
        )

        if len(batch) >= PING_BATCH_SIZE:
            db.TelemetryPings.bulk_write(batch, ordered=False)
            total += len(batch)
            batch = []
            print(f"  pings inserted: {total}/{NUM_PINGS}")

    if batch:
        db.TelemetryPings.bulk_write(batch, ordered=False)
        total += len(batch)

    print(f"seeded {total} TelemetryPings docs (target {NUM_PINGS})")


def main():
    ids = load_ids()
    db = get_db()

    if "--reset" in sys.argv[1:]:
        # delete_many keeps the collections and their indexes (2dsphere, TTL, unique)
        for name in ("VehicleMetadata", "TripReviews", "TelemetryPings"):
            db[name].delete_many({})
        print("emptied VehicleMetadata, TripReviews, TelemetryPings")

    seed_vehicle_metadata(db, ids["vehicle_ids"])
    seed_trip_reviews(db, ids["trips"])
    seed_telemetry_pings(db, ids["vehicle_ids"])

    print("done.")


if __name__ == "__main__":
    main()