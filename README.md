# RideSync

**Assignment 1, Project 2 — CS6.302 Software System Development**
**Group 26** 

GitHub: https://github.com/kushlalve07/1_a2 (Assignment 2 fork; inherited from https://github.com/varun15103/Group26)

RideSync is a ride-hailing database backend (Uber-style) with no frontend. It's a polyglot-persistence design:

- **PostgreSQL** — riders, drivers, vehicles, wallets, trips, and audit logs (the relational core, where integrity matters most)
- **MongoDB** — vehicle extras, ratings/reviews, and high-volume GPS telemetry pings (flexible/high-write data)

---

## Team responsibilities

| Step | Owner | Covers |
|---|---|---|
| Step 1 | Varun | Schema design (Postgres DDL, ERD, Mongo document shapes) |
| Step 2 | Supriyo | Trigger, partial index, materialized view, Mongo collections + 2dsphere + TTL indexes |
| Step 3 | Srivastan | Checkout stored procedure, window-function analytics query, nearest-vehicle geoNear, review stats facet |
| Later (together) | Everyone (Varun, Supriyo, Srivastan) | Fake data generation |

**Rule:** don't add new columns inside your own files — flag it, and we'll update `sql/01_schema_ddl.sql` and the ERD together so both sides stay in sync.

---

## Repo layout

```
sql/                schema, indexes, triggers, materialized views, stored procedures
docs/                ERD image + mongo_schema_map.json
mongo/                mongosh scripts (collections/indexes, geoNear workflow, $facet workflow)
data_generation/    python seeders (no generated data itself is committed)
performance/        EXPLAIN ANALYZE / explain("executionStats") output goes here after seeding
```

| File | Step | Purpose |
|---|---|---|
| `sql/01_schema_ddl.sql` | 1 | Core relational schema |
| `sql/02_indexes.sql` | 2 | Indexes incl. the partial unique index |
| `sql/03_triggers_and_audit.sql` | 2 | Wallet audit trigger |
| `sql/05_materialized_views.sql` | 2 | Completed-trips-per-vehicle materialized view |
| `mongo/01_collections_and_indexes.js` | 2 | Mongo collections, 2dsphere + TTL indexes |
| `sql/04_stored_procedures.sql` | 3 | Trip checkout procedure |
| `sql/06_window_analytics.sql` | 3 | Window-function analytics query |
| `mongo/02_workflow3_geonear.js` | 3 | Nearest available vehicle (geoNear) |
| `mongo/03_workflow4_facet.js` | 3 | Review stats ($facet) |
| `data_generation/postgres_seeder.py` | later | Seeds Postgres (riders, trips, wallet audit logs) |
| `data_generation/mongo_seeder.py` | later | Seeds Mongo (extras, reviews, GPS pings) |

---

## Shared conventions

- **IDs:** UUID in Postgres; the same value stored as a string in Mongo.
- **Trip status:** `REQUESTED`, `IN_TRANSIT`, `COMPLETED`.
- **Wallet `action_type`:** `DEBIT`, `CREDIT`, `ESCROW`.
- **GPS coordinates:** `[longitude, latitude]` — longitude first (GeoJSON order).
- **Timestamps:** `timestamptz` in Postgres, `Date` in Mongo.
- **Nearest-vehicle lookup** uses `TelemetryPings.is_available = true`.
- `vehicles.is_active` means the car is in the fleet — it says nothing about live GPS/availability.

---

## Design assumptions

- Postgres 13+, Mongo 6+.
- No separate escrow table — escrow amounts are deducted directly from `wallet_balance`. If a deduction would push the balance below 0, the check constraint fails and the transaction rolls back.
- `wallet_audit_logs` is insert-only; the step 2 trigger is the only thing that writes to it.
- `license_plate` is unique; vehicle `class` is one of `MINI`, `SEDAN`, `SUV`, `XL`.
- Every trip has a `vehicle_id` (no unassigned trips).
- A rider can only have one active trip at a time, enforced by a partial unique index:
  ```sql
  CREATE UNIQUE INDEX idx_active_rider_trip
    ON trips (rider_id)
    WHERE status IN ('REQUESTED', 'IN_TRANSIT');
  ```
- The materialized view aggregates completed trips per vehicle (count + fare sum); concurrent refresh requires a unique index on the view.
- GPS ping TTL is 2 hours, so seeded `created_at` values need to be recent or they'll expire before you can query them.
- Seeded GPS coordinates cluster around Hyderabad (lng 78.3–78.6, lat 17.3–17.5).

---

## Setup

**1. Clone and enter the repo.**

```bash
git clone https://github.com/kushlalve07/1_a2.git
cd 1_a2
```

**2. Create and activate the conda environment:**

```bash
conda create -n ridesync python=3.11 -y
conda activate ridesync
pip install -r requirements.txt
```
No conda? A plain venv works the same: `python3.11 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`.

**3. Start Postgres and Mongo (Docker):**

```bash
docker run -d --name ridesync-pg -e POSTGRES_PASSWORD=ridesync -e POSTGRES_DB=ridesync -p 5432:5432 postgres:16
docker run -d --name ridesync-mongo -p 27017:27017 mongo:7
sleep 5   # give them a moment to finish initializing
```

**4. Export connection settings** (so `psql` stops prompting for a password each time):

```bash
export PGHOST=localhost PGPORT=5432 PGDATABASE=ridesync PGUSER=postgres PGPASSWORD=ridesync
export MONGO_URI=mongodb://localhost:27017
export MONGO_DB=ridesync
```

---

## Run order

1. **Schema, indexes, triggers, materialized view:**
   ```bash
   psql -h localhost -U postgres -d ridesync -f sql/01_schema_ddl.sql
   psql -h localhost -U postgres -d ridesync -f sql/02_indexes.sql
   psql -h localhost -U postgres -d ridesync -f sql/03_triggers_and_audit.sql
   psql -h localhost -U postgres -d ridesync -f sql/05_materialized_views.sql
   ```
   (each prompts for the `ridesync` password unless `PGPASSWORD` is exported as above)

2. **Mongo collections and indexes:**
   ```bash
   mongosh ridesync mongo/01_collections_and_indexes.js
   ```

3. **Stored procedure:**
   ```bash
   psql -h localhost -U postgres -d ridesync -f sql/04_stored_procedures.sql
   ```

4. **Seed the data.** Full scale is 50k trips + 500k+ pings, which takes a while and uses real disk. Do a quick smoke test first to confirm everything wires up, then run the full seed once:
   ```bash
   # quick smoke test
   RIDESYNC_QUICK_SEED=1 python data_generation/postgres_seeder.py
   RIDESYNC_QUICK_SEED=1 python data_generation/mongo_seeder.py

   # full run, once you've confirmed it works
   # --reset empties the tables/collections first, so the smoke-test rows don't mix in
   python data_generation/postgres_seeder.py --reset
   python data_generation/mongo_seeder.py --reset
   ```
   Expected after the full run: 3,000 riders, 500 vehicles, 50,000 trips, about 110,000 `wallet_audit_logs` rows, 520,000 pings.

5. **Analytics workflows** (only after seeding — there's nothing to query before that):
   ```bash
   psql -h localhost -U postgres -d ridesync -f sql/06_window_analytics.sql
   mongosh ridesync mongo/02_workflow3_geonear.js
   mongosh ridesync mongo/03_workflow4_facet.js
   ```

6. **Refresh the materialized view and capture the Postgres explain plan:**
   ```bash
   psql -h localhost -U postgres -d ridesync -c "SELECT refresh_vehicle_trip_stats();"

   psql -h localhost -U postgres -d ridesync \
     -c "EXPLAIN ANALYZE $(cat sql/06_window_analytics.sql)" \
     > performance/postgres_explain_analyzes.txt
   ```
   Capture the Mongo `explain("executionStats")` output for workflows 3 and 4 the same way and save both into `performance/`.

7. **Cleanup when done:**
   ```bash
   docker stop ridesync-pg ridesync-mongo
   docker rm ridesync-pg ridesync-mongo
   conda deactivate
   ```

---

## PLANS

Recaptured in Assignment 2 on the full seed (50,000 trips, 520,000 pings), after the index changes listed below. Raw output is in `performance/`.

**Workflow 2 — Postgres `EXPLAIN (ANALYZE, BUFFERS)`:** index-only scan on `idx_trips_completed_vehicle_created`, no sequential scan on `trips`.
```
                                                                                              QUERY PLAN                                                                                              
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Incremental Sort  (cost=12939.10..16329.29 rows=47275 width=96) (actual time=30.480..35.527 rows=19924 loops=1)
   Sort Key: moving_avg.trip_day, (dense_rank() OVER (?))
   Presorted Key: moving_avg.trip_day
   Full-sort Groups: 46  Sort Method: quicksort  Average Memory: 29kB  Peak Memory: 29kB
   Pre-sorted Groups: 46  Sort Method: quicksort  Average Memory: 49kB  Peak Memory: 49kB
   Buffers: shared hit=389
   ->  WindowAgg  (cost=12925.05..13870.55 rows=47275 width=96) (actual time=30.384..33.851 rows=19924 loops=1)
         Buffers: shared hit=386
         ->  Sort  (cost=12925.05..13043.24 rows=47275 width=88) (actual time=30.382..30.837 rows=19924 loops=1)
               Sort Key: moving_avg.trip_day, moving_avg.moving_avg_7day DESC
               Sort Method: quicksort  Memory: 2014kB
               Buffers: shared hit=386
               ->  Subquery Scan on moving_avg  (cost=8.23..6989.93 rows=47275 width=88) (actual time=0.063..24.604 rows=19924 loops=1)
                     Buffers: shared hit=383
                     ->  WindowAgg  (cost=8.23..6517.18 rows=47275 width=88) (actual time=0.062..23.713 rows=19924 loops=1)
                           Buffers: shared hit=383
                           ->  GroupAggregate  (cost=8.23..5571.68 rows=47275 width=56) (actual time=0.057..14.116 rows=19924 loops=1)
                                 Group Key: trips.vehicle_id, (date_trunc('day'::text, trips.created_at))
                                 Buffers: shared hit=383
                                 ->  Incremental Sort  (cost=8.23..4508.00 rows=47275 width=30) (actual time=0.053..8.969 rows=47254 loops=1)
                                       Sort Key: trips.vehicle_id, (date_trunc('day'::text, trips.created_at))
                                       Presorted Key: trips.vehicle_id
                                       Full-sort Groups: 500  Sort Method: quicksort  Average Memory: 28kB  Peak Memory: 28kB
                                       Pre-sorted Groups: 500  Sort Method: quicksort  Average Memory: 29kB  Peak Memory: 29kB
                                       Buffers: shared hit=383
                                       ->  Index Only Scan using idx_trips_completed_vehicle_created on trips  (cost=0.41..2355.73 rows=47275 width=30) (actual time=0.022..4.573 rows=47254 loops=1)
                                             Heap Fetches: 0
                                             Buffers: shared hit=380
 Planning:
   Buffers: shared hit=238
 Planning Time: 0.271 ms
 Execution Time: 36.012 ms
(32 rows)
```

**Workflow 3 — Mongo `explain("executionStats")`** (`workflow3_geonear` in `performance/mongo_execution_stats.json`):

| Field | Value |
|---|---|
| Winning plan | `GEO_NEAR_2DSPHERE` on index `geo_location` (no `COLLSCAN`) |
| `nReturned` | 22,746 |
| `totalKeysExamined` | 76,943 |
| `totalDocsExamined` | 130,930 |
| `executionTimeMillis` | 165 |

**Workflow 4 — Mongo `explain("executionStats")`** (`workflow4_facet`, scoped to one vehicle):

| Field | Value |
|---|---|
| Winning plan | `IXSCAN` on index `idx_vehicle_id`, then `FETCH` (no `COLLSCAN`) |
| `nReturned` | 62 |
| `totalKeysExamined` | 62 |
| `totalDocsExamined` | 62 |
| `executionTimeMillis` | 0 |

Run fleet-wide (no `vehicle_id`), Workflow 4 reads every review, so a collection scan is expected there.

---

## Assignment 2: changes to the inherited scripts

This repository was inherited for Assignment 2. Every change made to the Part A scripts is listed here. The reasons and the evidence are in [docs/handover_note.md](docs/handover_note.md). The API plan is in [docs/api_endpoints.md](docs/api_endpoints.md).

| File | Change |
|---|---|
| `data_generation/postgres_seeder.py` | Top-ups run before trips; wallet updates no longer drop rows when a rider repeats in a batch; the trip loop runs until 50,000; open trips only use active vehicles; `--reset` flag; `ANALYZE` at the end |
| `data_generation/mongo_seeder.py` | `--reset` flag |
| `sql/02_indexes.sql` | Five new indexes (Workflow 2 covering index, trips by rider / vehicle / date, audit rows by rider and time) |
| `sql/03_triggers_and_audit.sql` | `wallet_audit_logs` is now append-only (trigger blocks `UPDATE`/`DELETE`); audit timestamp uses `clock_timestamp()` |
| `sql/04_stored_procedures.sql` | `book_trip` rejects a fare that is not above 0, an unknown vehicle and an inactive vehicle, each with its own SQLSTATE (`RS001`–`RS004`) |
| `mongo/01_collections_and_indexes.js` | Index on `TripReviews.vehicle_id` |
| `mongo/02_workflow3_geonear.js`, `mongo/03_workflow4_facet.js` | Results are printed; Workflow 4 runs fleet-wide unless a vehicle id is set |
| `performance/*` | Both files recaptured (the Mongo file was `null`) |
