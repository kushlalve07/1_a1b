-- RideSync Assignment 2 compatibility migration.
-- Safe to run on an existing Assignment 1 database after sql/05_materialized_views.sql
-- was already applied. Fresh installations also receive this table/function in file 05.
CREATE TABLE IF NOT EXISTS mv_vehicle_trip_stats_refresh (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    last_refreshed_at TIMESTAMPTZ NOT NULL
);
INSERT INTO mv_vehicle_trip_stats_refresh (id, last_refreshed_at)
VALUES (1, clock_timestamp()) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION refresh_vehicle_trip_stats()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_vehicle_trip_stats;
    INSERT INTO mv_vehicle_trip_stats_refresh (id, last_refreshed_at)
    VALUES (1, clock_timestamp())
    ON CONFLICT (id) DO UPDATE SET last_refreshed_at = EXCLUDED.last_refreshed_at;
END;
$$ LANGUAGE plpgsql;
