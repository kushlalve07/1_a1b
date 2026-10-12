-- RideSync project 2, step 2
-- partial index: one rider can have at most one REQUESTED/IN_TRANSIT trip at a time.
-- postgres enforces this as a unique index scoped to the partial WHERE clause,
-- so completed trips don't collide with each other or with a later active trip.

CREATE UNIQUE INDEX idx_active_rider_trip
    ON trips (rider_id)
    WHERE status IN ('REQUESTED', 'IN_TRANSIT');

-- ---------------------------------------------------------------------------
-- added in assignment 2 (see docs/handover_note.md)
-- the part A scripts only had the partial unique index above, so every other
-- lookup was a sequential scan. these back the queries the web app runs.

-- workflow 2 reads only COMPLETED trips and only these three columns, so this
-- partial covering index lets it run as an index-only scan instead of a seq scan.
CREATE INDEX IF NOT EXISTS idx_trips_completed_vehicle_created
    ON trips (vehicle_id, created_at)
    INCLUDE (fare_amount)
    WHERE status = 'COMPLETED';

-- trips of one rider / one vehicle, newest first (detail pages)
CREATE INDEX IF NOT EXISTS idx_trips_rider_created
    ON trips (rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle_created
    ON trips (vehicle_id, created_at DESC);

-- paging through all trips newest first without sorting 50k rows per page
CREATE INDEX IF NOT EXISTS idx_trips_created
    ON trips (created_at DESC, id);

-- audit trail of one rider, in time order, with a date filter
CREATE INDEX IF NOT EXISTS idx_wallet_audit_rider_time
    ON wallet_audit_logs (rider_id, "timestamp" DESC);
