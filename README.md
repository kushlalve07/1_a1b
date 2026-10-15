# RideSync — Fleet operations console

**Inherited project:** P2 RideSync · Group 26 Assignment 1 backend  
**Stack:** PostgreSQL + MongoDB + Express/Node.js + responsive HTML/CSS/JavaScript

RideSync is a restrained, responsive operations console for a ride-hailing platform. It retains the inherited Assignment 1 database and adds a browser UI and API for the four required workflows: atomic trip booking, window-function analytics, MongoDB `$geoNear`, and MongoDB `$facet`.

## What's included

- `api/` — Express API, request validation, parameterized SQL, MongoDB aggregation, error mapping and Dockerfile.
- `web/` — responsive single-page operations console; no frontend build step or extra UI framework required.
- `sql/`, `mongo/`, `data_generation/` — inherited Part A schema, procedures, triggers, indexes, analytics and seeders, with documented Assignment 2 fixes.
- `docs/handover_note.md` — inherited-system handover and known issues/fixes.
- `docs/api_endpoints.md` — endpoint contract for the UI and workflow mapping.

## Quick start — Docker (recommended)

Prerequisites: Docker Engine + Docker Compose, Python 3.11+, and `mongosh` (or another way to run a Mongo shell script). For full seed data, allow time and disk for 50,000 trips and 520,000 telemetry pings.

1. Start the services from the repository root:

   ```bash
   docker compose up --build -d
   docker compose ps
   ```

   On a **fresh named volume**, PostgreSQL automatically applies the ordered `sql/*.sql` initialization scripts. Initialization scripts run only when the Postgres data directory is empty. If the database volume already existed before the refresh timestamp change, apply the migration in step 2.

2. Create MongoDB collections and indexes (safe to re-run):

   ```bash
   mongosh 'mongodb://localhost:27017/ridesync' mongo/01_collections_and_indexes.js
   ```

   If you are connecting to an existing Assignment 1 database rather than a fresh Docker volume, apply the Assignment 2 refresh timestamp migration:

   ```bash
   docker compose exec -T postgres psql -U postgres -d ridesync < sql/07_assignment2_refresh_timestamp.sql
   ```

3. Set up the Python seeder environment:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

4. Seed demo data. Start with a smoke-test dataset:

   ```bash
   RIDESYNC_QUICK_SEED=1 PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=ridesync PGUSER=postgres PGPASSWORD=ridesync \
     python data_generation/postgres_seeder.py --reset
   RIDESYNC_QUICK_SEED=1 MONGO_URI=mongodb://127.0.0.1:27017 MONGO_DB=ridesync \
     python data_generation/mongo_seeder.py --reset
   ```

   For the full dataset, run both commands again **without** `RIDESYNC_QUICK_SEED=1`, keeping `--reset` on both so the quick data is not mixed with the full seed:

   ```bash
   PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=ridesync PGUSER=postgres PGPASSWORD=ridesync \
     python data_generation/postgres_seeder.py --reset
   MONGO_URI=mongodb://127.0.0.1:27017 MONGO_DB=ridesync \
     python data_generation/mongo_seeder.py --reset
   ```

   The PostgreSQL seeder writes `data_generation/generated_ids/ids.json`, which the Mongo seeder uses to preserve cross-database UUIDs. Generated IDs are local runtime data and are intentionally not committed. The full seed targets 3,000 riders, 500 vehicles, 50,000 trips and 520,000 telemetry pings; the seeder prints actual counts as it runs. GPS pings expire after two hours by design.

5. Open **http://localhost:5000**. Check **System status** in the sidebar or visit `http://localhost:5000/api/health`. PostgreSQL-backed screens can work if MongoDB is temporarily unavailable; live map and review screens require MongoDB.

6. To stop the services:

   ```bash
   docker compose down
   ```

   This preserves named database volumes. To delete all database data and reinitialize from scratch (destructive): `docker compose down -v`.

## Local API alternative (without Docker for the API)

Start PostgreSQL and MongoDB locally, apply SQL files in order (`01_schema_ddl.sql` through `07_assignment2_refresh_timestamp.sql`), and run the Mongo index script. Then install and run the API:

```bash
cd api
npm install
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=ridesync PGUSER=postgres PGPASSWORD=ridesync \
MONGO_URI=mongodb://127.0.0.1:27017 MONGO_DB=ridesync npm start
```

The frontend is served by Express from `web/`; no Vite, React build, or frontend compilation is required. Keep database credentials in environment variables; `.env.example` documents the local defaults. Do not commit real credentials.

## Application walkthrough

1. **Overview:** fleet KPIs, a per-vehicle revenue trend, latest trips and service health.
2. **Fleet & trips:** paginated trips, vehicles and riders; search, status/class filters and record detail. Trip status can advance `REQUESTED → IN_TRANSIT → COMPLETED` one step at a time.
3. **Book a trip:** selects a rider and active vehicle, calls `book_trip`, and displays wallet balance before/after plus the trigger-generated `ESCROW` audit row. Insufficient funds and an already-active trip receive actionable messages.
4. **Wallet audit:** read-only wallet ledger filtered by rider and date range; the recorded `balance_after` is shown as the historical balance.
5. **Analytics:** the inherited seven-day `RANGE` moving-average query and `DENSE_RANK()` leaderboard, plus materialized-view totals, a recorded refresh time and refresh action.
6. **Live map:** selectable origin, 5 km `$geoNear` results, sorted nearby list and five-second polling. **Simulate movement** inserts fresh telemetry pings for a live demo.
7. **Reviews & catalog:** `$facet`-backed rating distribution, feedback tags, average score, paginated reviews and flexible `VehicleMetadata` fields/inspection history.

## Important assumptions and operational notes

- There is no real authentication/authorization. Do not expose it to the public internet with seeded credentials.
- UUIDs are shared between PostgreSQL and MongoDB as strings; GeoJSON coordinates are `[longitude, latitude]`.
- The map is a custom illustrative street-grid canvas rather than a commercial basemap; vehicle positions are shown relative to the selected origin. It is suitable for demonstrating `$geoNear`, not turn-by-turn navigation.
- The `wallet_audit_logs` table is append-only through row-level `UPDATE`/`DELETE` protection. Database owners can still truncate it for a reset.
- `mv_vehicle_trip_stats` is intentionally materialized and can be stale until refreshed. The dashboard displays the last refresh time.
- Telemetry TTL is 7,200 seconds. Empty map results are valid when pings expire or no available vehicle is in range; use the simulator for a demo.
- Do not use the browser to load the entire trips table. The API bounds pages and validates pagination/filter inputs.
- If your inherited database already has the Assignment 1 objects, **do not re-run `sql/01_schema_ddl.sql` blindly**; it contains base `CREATE TABLE` statements. Apply only needed migrations and check `docs/handover_note.md` first.

## Tests and quality checks

Run from the repository root:

```bash
node --check api/server.js
node --check web/assets/app.js
python -m compileall -q data_generation
node --test tests/*.test.js
```

## Team Contribution

| Team member | Contribution |
|---|---|
| Suhansh Varshney | Configured UI / UX and wireframes and documented README |
| Samruddhi Shet | Configured docker for easy setup of project and UI / UX, frontend |
| Kushl Alve | Setup API endpoints and created API endpoint, handover documentation |
| Vishwanth Beereddy | Fixed inherited assignment 1 repo issues and setup API endpoints |