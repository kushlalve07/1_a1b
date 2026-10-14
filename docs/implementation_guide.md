# RideSync Assignment 2 — Implementation report and runbook

**Course:** CS6.302 Software System Development  
**Assignment:** 2 — Front End Design  
**Inherited project:** P2 RideSync (ride-hailing)  
**Prepared:** 14 October 2026

## 1. Summary of work completed

The inherited Assignment 1 backend was retained and wrapped with a responsive web application and an Express API. The interface follows a “quiet precision” design system: deep ink `#172B35`, warm paper `#F6F5F0`, aged brass `#B88C50`, and muted teal `#2E746D`. Typography uses Manrope, DM Sans, and DM Mono, with system fallbacks. Layouts adapt to laptop and phone widths; controls include keyboard focus states and reduced-motion support.

Implemented screens and connections:

- **Overview:** service health, fleet KPIs, recent trips and a revenue chart.
- **Fleet & trips:** paginated/searchable trips, vehicles and riders; status/class filters; detail dialogs; guarded trip-status transitions.
- **Book a trip:** server-side validation and the inherited `book_trip` procedure, friendly SQLSTATE/constraint error mapping, before/after balance and the corresponding audit row.
- **Wallet audit:** read-only date-filtered `wallet_audit_logs` history.
- **Analytics:** seven-day moving average (`RANGE` window), `DENSE_RANK()` daily ranking, materialized-view summary and refresh action with last-refreshed timestamp.
- **Live map:** parameterized `$geoNear` capped at 5 km, nearest-per-vehicle grouping, polling every five seconds and a telemetry simulator for demonstrations.
- **Reviews & catalog:** `$facet` rating distribution/tag frequency/average score, paginated reviews, and flexible `VehicleMetadata` rendering including unknown fields.

Additional implementation work:

- Added `api/server.js` with parameterized SQL, bounded pagination, UUID/date/filter validation, JSON error responses, a health endpoint and graceful shutdown.
- Added Docker Compose for PostgreSQL, MongoDB and the API, plus a container build file.
- Made Mongo collection/index initialization safe to re-run.
- Added `sql/07_assignment2_refresh_timestamp.sql` for an existing database and added the same refresh timestamp support to the fresh-install materialized-view setup.
- Added design notes, an SVG wireframe, API documentation and local static-contract tests.

## 2. Repository file guide

| File / folder | What it does | When it is used |
|---|---|---|
| `README.md` | Primary setup guide, walkthrough, assumptions and submission checklist | Read first; update team/repository/demo details before submitting |
| `Assignment1b(1).pdf` | Assignment brief (provided separately with the task) | Source of workflow and grading requirements; not copied into the repository |
| `api/server.js` | Express API for all screens and workflows | Runs as the app server on port 5000 |
| `api/package.json` | Node dependencies and scripts | `npm install`, `npm start`, `npm test` |
| `api/Dockerfile` | Builds API + static frontend image | Used by `docker compose up --build` |
| `web/index.html` | All screen structure and semantic controls | Served by Express at `/` |
| `web/assets/styles.css` | Design tokens, responsive layout, components, states and breakpoints | Loaded by `index.html` |
| `web/assets/app.js` | UI state, API calls, tables, charts, forms, polling and interactions | Loaded by `index.html` |
| `docker-compose.yml` | Local PostgreSQL, MongoDB and API services | Recommended way to start the application |
| `.env.example` | Documents local environment variable names/defaults | Copy values into your shell or a local `.env` workflow; never commit secrets |
| `sql/01_schema_ddl.sql` | Base PostgreSQL tables | Fresh database initialization only |
| `sql/02_indexes.sql` | Relational indexes including the active-trip partial unique index | After base schema |
| `sql/03_triggers_and_audit.sql` | Wallet audit trigger and append-only protection | After base schema |
| `sql/04_stored_procedures.sql` | `book_trip` atomic booking procedure | Before booking transactions |
| `sql/05_materialized_views.sql` | Vehicle stats materialized view, unique index, refresh function and timestamp metadata | After schema; fresh database setup |
| `sql/06_window_analytics.sql` | Inherited seven-day revenue and `DENSE_RANK()` query | Analytics logic reference / direct SQL run |
| `sql/07_assignment2_refresh_timestamp.sql` | Idempotent compatibility migration for refresh timestamp support | Existing Assignment 1 databases; safe to reapply |
| `mongo/01_collections_and_indexes.js` | Creates Mongo collections and required indexes | Once per database; safe to re-run |
| `mongo/02_workflow3_geonear.js` | Standalone nearest-available-vehicle pipeline | Optional direct Part A workflow check |
| `mongo/03_workflow4_facet.js` | Standalone review `$facet` pipeline | Optional direct Part A workflow check |
| `data_generation/postgres_seeder.py` | Generates relational seed data, balances/audit history and cross-database IDs | Run before Mongo seeder |
| `data_generation/mongo_seeder.py` | Generates metadata, reviews and recent telemetry pings | Run after PostgreSQL seeder |
| `data_generation/generated_ids/ids.json` | Runtime mapping of matching PostgreSQL UUIDs for Mongo documents | Generated locally; intentionally ignored by Git |
| `docs/handover_note.md` | Inherited backend handover, issues found and corrections made | Supports Step 1 handover grading |
| `docs/api_endpoints.md` | API contracts and endpoint-to-screen mapping | API/UI integration reference |
| `docs/mongo_schema_map.json` | Example flexible Mongo document shapes and coordinate conventions | Seed and API schema reference |
| `docs/relational_erd.png` | Inherited relational ERD | Understand PostgreSQL relationships |
| `docs/design/README.md` | Users, visual design system and reusable UI patterns | Design documentation |
| `docs/design/wireframe.svg` | Low-fidelity desktop layout wireframe | Step 2 design deliverable; open in browser or vector editor |
| `performance/postgres_explain_analyzes.txt` | Captured inherited PostgreSQL query plan | Performance evidence from Part A; regenerate after a materially different seed/schema |
| `performance/mongo_execution_stats.json` | Captured Mongo execution-stat evidence | Performance evidence from Part A; regenerate after a materially different seed/indexes |
| `requirements.txt` | Python seed-data dependencies | Install before running seeders |
| `tests/static_contract.test.js` | Checks syntax and expected screens/API workflow routes without databases | Run via `node --test tests/*.test.js` |

## 3. Run the assignment from a clean machine

### Prerequisites

- Docker Engine and Docker Compose plugin
- Python 3.11 or newer compatible with the seeders
- `mongosh` for creating Mongo indexes (or MongoDB Compass / another Mongo shell)
- Node.js 20+ only if running the API outside Docker

### Start services

From the repository root:

```bash
docker compose up --build -d
docker compose ps
```

PostgreSQL applies SQL files in lexical order on first initialization of its data volume. Mongo collections/indexes are initialized explicitly:

```bash
mongosh 'mongodb://localhost:27017/ridesync' mongo/01_collections_and_indexes.js
```

If PostgreSQL's volume was initialized before the refresh timestamp addition, run:

```bash
docker compose exec -T postgres psql -U postgres -d ridesync < sql/07_assignment2_refresh_timestamp.sql
```

### Seed the data

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Smoke-test dataset; reset both stores to avoid mixing data.
RIDESYNC_QUICK_SEED=1 PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=ridesync PGUSER=postgres PGPASSWORD=ridesync \
  python data_generation/postgres_seeder.py --reset
RIDESYNC_QUICK_SEED=1 MONGO_URI=mongodb://127.0.0.1:27017 MONGO_DB=ridesync \
  python data_generation/mongo_seeder.py --reset
```

For the full assignment dataset, repeat the two commands with `RIDESYNC_QUICK_SEED=1` removed, keeping `--reset` on both commands. This creates the relational IDs before Mongo references them. The full target is 3,000 riders, 500 vehicles, 50,000 trips and 520,000 telemetry pings; check the actual seeder output rather than assuming every target was met. Mongo's TTL index removes telemetry older than two hours.

### Open and verify

Visit `http://localhost:5000`. Check `http://localhost:5000/api/health` for PostgreSQL and MongoDB status. Suggested demo path:

1. Browse a rider and vehicle, then inspect a trip.
2. Book a trip with a sufficient balance and show the before/after balance and audit entry.
3. Try to book again for the same rider while the first trip is active; show the friendly constraint error.
4. Advance the first trip through `IN_TRANSIT` and `COMPLETED`, then book again.
5. Filter the wallet audit and point out the `ESCROW`/`CREDIT` entries.
6. Open analytics, refresh the materialized view, and show the refreshed timestamp and ranked table.
7. Open the live map, simulate telemetry, and show the nearby list update without a page reload.
8. Open reviews and catalog metadata, including rating distribution and inspection history.

Stop services with `docker compose down`. This preserves database volumes. `docker compose down -v` deletes the database volumes and is destructive.

## 4. API overview

| Route | Workflow | Important behavior |
|---|---|---|
| `GET /api/health` | All | Reports Postgres/Mongo readiness |
| `GET /api/riders`, `GET /api/riders/:id` | Browse / actor | Search and bounded pagination; active-trip indicator |
| `GET /api/vehicles`, `GET /api/vehicles/:id` | Browse / catalog | Search, class/active filters, stats and flexible metadata |
| `GET /api/trips`, `GET /api/trips/:id` | Browse | Status/date/actor filters, bounded pagination, optional review |
| `POST /api/trips` | Workflow 1 | Calls `book_trip`; maps SQLSTATE and named constraints to clear HTTP errors |
| `PATCH /api/trips/:id/status` | Status demo | Conditional update prevents skipped or concurrent transitions |
| `POST /api/riders/:id/wallet/topup` | Demo helper | Positive amount only; trigger emits a credit audit row |
| `GET /api/riders/:id/audit` | Audit | Date-filtered, read-only audit entries |
| `GET /api/analytics/moving-average` | Workflow 2 | Retains the seven-day `RANGE` window; filters final rows after computing window |
| `GET /api/analytics/rankings` | Workflow 2 | Uses `DENSE_RANK()` for a selected/latest day |
| `GET /api/analytics/vehicle-stats`, `POST /api/analytics/vehicle-stats/refresh` | Materialized view | Paged stats, refresh action and timestamp |
| `GET /api/vehicles/nearby`, `POST /api/telemetry/simulate` | Workflow 3 | `$geoNear` is first; radius capped at 5,000 metres; simulation adds fresh pings |
| `GET /api/reviews/stats`, `GET /api/reviews` | Workflow 4 | One `$facet` pipeline for stats; paginated review listing |

The full request/response contract is in `docs/api_endpoints.md`.

## 5. Validation, failure states and limitations

- API SQL uses bound parameters for user input; only a server-allowlisted sort expression is interpolated into SQL.
- Pagination has server-side bounds. UUIDs, dates, status values, classes, fare amounts and top-ups are validated.
- Booking uses the stored procedure on an autocommit call because the inherited procedure controls its own transaction. Constraint and SQLSTATE codes are used for errors, not message-text matching.
- Trip transitions use a conditional update against the expected previous state, avoiding a stale read followed by an unconditional update.
- Mongo-dependent endpoints return a structured `503` when Mongo is unavailable; the SQL-based screens remain accessible.
- Frontend text is HTML-escaped before being inserted into generated markup. Loading, empty and error states are shown instead of leaving a blank screen.
- The map background is an original illustrative schematic, not a real geospatial basemap. Coordinates and distance come from MongoDB results; the schematic placement is visual only.
- There is no real authentication or authorization because the assignment says it is not required. Do not deploy publicly as-is.
- A live database/browser test could not be executed in this build environment because Docker and the Node dependency registry were not available here. Syntax and static-contract checks are included, but the team must perform the database-backed demo and tests before claiming end-to-end verification.

## 6. Checks and submission checklist

Run:

```bash
node --check api/server.js
node --check web/assets/app.js
python -m compileall -q data_generation
node --test tests/*.test.js
```

Before Moodle submission:

- [ ] Run the full stack with seeded PostgreSQL and MongoDB.
- [ ] Test booking success, insufficient balance, active-trip conflict, and status transitions.
- [ ] Verify audit entry, analytics refresh timestamp, live map polling, `$facet` charts and metadata rendering.
- [ ] Capture a demo video no longer than five minutes and link it in `README.md`.
- [ ] Add the correct new team number, actual four-member contribution table, shared GitHub repository URL and final commit hash.
- [ ] Create one ZIP named `<new_team_number>_a1b.zip`, under 20 MB; exclude dependency folders, virtual environments, Python caches, build output and database dumps.
