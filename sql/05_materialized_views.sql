-- RideSync project 2, step 2
-- materialized view: every vehicle with its lifetime completed-trip count and total earnings.
-- LEFT JOIN so vehicles with zero completed trips still show up, with 0 / 0.00 instead of
-- disappearing.

CREATE MATERIALIZED VIEW mv_vehicle_trip_stats AS
SELECT
    v.id                                                              AS vehicle_id,
    v.license_plate,
    v.class,
    COUNT(t.id)      FILTER (WHERE t.status = 'COMPLETED')            AS completed_trip_count,
    COALESCE(SUM(t.fare_amount) FILTER (WHERE t.status = 'COMPLETED'), 0.00)
                                                                       AS total_earnings
FROM vehicles v
LEFT JOIN trips t ON t.vehicle_id = v.id
GROUP BY v.id, v.license_plate, v.class
WITH DATA;

-- REFRESH ... CONCURRENTLY requires a unique index on the view (so postgres can diff
-- old vs new rows instead of locking readers out). one row per vehicle_id, so this works.
CREATE UNIQUE INDEX idx_mv_vehicle_trip_stats_vehicle_id
    ON mv_vehicle_trip_stats (vehicle_id);

-- Assignment 2 addition: retain the time at which the dashboard last refreshed the view.
CREATE TABLE IF NOT EXISTS mv_vehicle_trip_stats_refresh (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    last_refreshed_at TIMESTAMPTZ NOT NULL
);
INSERT INTO mv_vehicle_trip_stats_refresh (id, last_refreshed_at)
VALUES (1, clock_timestamp()) ON CONFLICT (id) DO NOTHING;

-- Wrapper function: refresh the view and record the timestamp in the same call.
-- CONCURRENTLY keeps readers available while PostgreSQL computes the replacement.
CREATE OR REPLACE FUNCTION refresh_vehicle_trip_stats()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_vehicle_trip_stats;
    INSERT INTO mv_vehicle_trip_stats_refresh (id, last_refreshed_at)
    VALUES (1, clock_timestamp())
    ON CONFLICT (id) DO UPDATE SET last_refreshed_at = EXCLUDED.last_refreshed_at;
END;
$$ LANGUAGE plpgsql;