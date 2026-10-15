# Handover note: RideSync (Project 2), inherited from Group 26

Written for Assignment 2, Step 1. It covers what we ran, what worked, what did not, what we changed, and what we would tell the original authors.

## How we ran it

We used `postgres:16` and `mongo:7`, schema and Mongo scripts in the README's order, then the quick seed, then the full seed. The one deviation: we used a Python 3.11 `venv` instead of conda. `requirements.txt` is unpinned and resolved to Faker 40.43, psycopg2-binary 2.9.13 and pymongo 4.18.3.

## What worked

- All six SQL files and `mongo/01_collections_and_indexes.js` loaded with no errors on the first try.
- `book_trip` behaves correctly: it debits the wallet, tags the audit row `ESCROW`, inserts a `REQUESTED` trip, and leaves nothing behind when the wallet CHECK or the partial unique index rejects the booking.
- The audit trigger logs every balance change with the right sign and `balance_after`. The `ESCROW` tag passed through a transaction-local setting is a neat idea and does not leak between transactions.
- The materialized view and `refresh_vehicle_trip_stats()` work, including the first refresh on an empty view.
- Workflow 2 returns sensible rows and uses `RANGE` (calendar days), which is right for vehicles with gap days.
- The `$geoNear` and `$facet` pipelines are correct once they are given real input and their output is printed.
- The README is clear about conventions (`[lng, lat]`, `is_active` vs `is_available`, TTL and seed timing).

## What did not work

| # | Problem | Evidence |
| --- | --- | --- |
| 1 | The full seed produced **37,426 trips, not 50,000**. Trips were booked before top-ups, and 50k fares cost about twice the riders' opening balances, so a quarter of the bookings were skipped and 10k more were shrunk to tiny fares. | Seeder printed `seeded 37426 trips (target 50000)`. The plan committed in `performance/` also shows only 37,957 trips. |
| 2 | The full seed produced **95,796 audit rows, not 100,000+**. `UPDATE ... FROM (VALUES ...)` applies only one delta when a rider appears twice in one statement, so about 2% of wallet changes were dropped with no error. | Fares summed to 8,148,626.74 but `ESCROW` rows summed to 7,939,670.44. |
| 3 | Following the README (quick seed, then full seed) **mixes both data sets**: 3,100 riders and 530 vehicles. There was no way to reset. | Row counts after both steps. |
| 4 | `mongosh ridesync mongo/02_...js` and `03_...js` **print nothing**. mongosh does not echo expression values from a script file. | Empty output. |
| 5 | Workflow 4 was scoped to a **hardcoded vehicle id that is not in the data**, so all three facets were empty. | `[{rating_distribution: [], ...}]` |
| 6 | `performance/mongo_execution_stats.json` contained **`null` for both workflows**. | File contents. |
| 7 | Workflow 2 ran as a **sequential scan** on `trips`. The only index in the schema was the partial unique one. | `Seq Scan on trips` in the committed plan. |
| 8 | `wallet_audit_logs` is described as insert-only, but **`UPDATE` and `DELETE` both succeeded**. | `UPDATE 5`, `DELETE 5` in a test transaction. |
| 9 | `book_trip` **accepted a booking on an inactive vehicle**, and a zero fare created a trip with no audit row. | Test calls. |
| 10 | Audit rows written in one transaction **shared one timestamp** (`NOW()` is the transaction start), so a rider's history could not be put in order. | 424 riders whose latest audit row did not match their balance. |

## What we changed, and why

| File | Change | Why |
| --- | --- | --- |
| `data_generation/postgres_seeder.py` | Top-ups run before trips; wallet updates are split so each statement touches a rider once; the trip loop runs until 50,000; open trips only use active vehicles; `--reset` flag; `ANALYZE` at the end. | Fixes 1, 2, 3. Result: exactly 50,000 trips and about 110,000 audit rows, and fares now equal `ESCROW` debits to the paisa. |
| `data_generation/mongo_seeder.py` | `--reset` flag. | Fixes 3. |
| `mongo/02_workflow3_geonear.js`, `03_workflow4_facet.js` | Results are printed; Workflow 4 runs fleet-wide unless a vehicle id is set. | Fixes 4, 5. The pipelines themselves are unchanged. |
| `sql/02_indexes.sql` | Five indexes: a partial covering index for Workflow 2, trips by rider, trips by vehicle, trips by date, audit rows by rider and time. | Fixes 7 (now an index-only scan with 0 heap fetches) and backs the browse and audit screens. |
| `mongo/01_collections_and_indexes.js` | Index on `TripReviews.vehicle_id`. | Per-vehicle review stats scanned all reviews; now 62 keys for 62 documents. |
| `sql/03_triggers_and_audit.sql` | Trigger that blocks `UPDATE`/`DELETE` on the audit table; audit timestamp uses `clock_timestamp()`. | Fixes 8, 10. |
| `sql/04_stored_procedures.sql` | Checks for fare > 0, vehicle exists, vehicle active, each with its own SQLSTATE (`RS001` to `RS004`). Signature unchanged. | Fixes 9, and lets the API show a specific message without parsing error text. |
| `performance/*` | Both files recaptured on the full seed. | Fixes 6. |

## Suggestions for the original authors

1. Check the seeder's output against its targets. It printed `37426 (target 50000)` and the shortfall still shipped.
2. Reconcile after seeding: `SUM(fare_amount)` against the audit debits would have exposed the dropped updates.
3. 'wallet_audit_logs' table is insert-only, enforce it in the database.

## Assignment 2 — frontend and API

The Assignment 2 implementation adds `api/` and `web/` without replacing the inherited PostgreSQL/MongoDB workflows. The browser calls an Express API; SQL remains parameterized and the database procedures, triggers, views and Mongo pipelines remain the authoritative workflow logic. `docs/api_endpoints.md` describes the route contracts.

The new UI includes Overview, Fleet & Trips, Book a Trip, Wallet Audit, Analytics, Live Map, and Reviews & Catalog. It uses bounded result pages, client-side loading/empty/error states, and responsive layouts. The map polls at five-second intervals and offers a telemetry simulator for a demo. Rider details include a demo wallet top-up action, which exercises the inherited wallet audit trigger.

`sql/05_materialized_views.sql` now stores the last materialized-view refresh time in `mv_vehicle_trip_stats_refresh`; `sql/07_assignment2_refresh_timestamp.sql` is the compatibility migration for a database where the original materialized view was already created. Mongo collection creation is now safe to rerun. The implementation has syntax and static-contract tests, but a complete database-backed run must still be performed on the team's machine because the build environment used for this handover did not have Docker or access to the Node package registry.
