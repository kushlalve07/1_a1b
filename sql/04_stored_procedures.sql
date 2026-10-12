-- RideSync project 2, step 3
-- Workflow 1: atomic booking. Moves fare_amount out of the rider's wallet_balance
-- (logged as ESCROW via the step-2 trigger flag), then inserts the trip. If the
-- wallet CHECK constraint (balance >= 0) fails, the whole call rolls back
-- automatically -- no trip row gets created and no partial state is left behind.
--
-- Depends on:
--   sql/01_schema_ddl.sql   -- riders.wallet_balance CHECK, trips table
--   sql/02_indexes.sql      -- idx_active_rider_trip (blocks a 2nd active trip for the rider)
--   sql/03_triggers_and_audit.sql -- trg_wallet_audit_log reads ridesync.wallet_action_type
--
-- Usage (must be called as a top-level CALL, not inside an existing multi-statement
-- transaction block, since this procedure issues its own COMMIT):
--   CALL book_trip('<rider_uuid>', '<vehicle_uuid>', 250.00, NULL);
--
-- Errors a caller should expect (all of them leave nothing behind):
--   SQLSTATE 23514, constraint riders_wallet_balance_check -> not enough wallet balance
--   SQLSTATE 23505, constraint idx_active_rider_trip       -> rider already has an active trip
--   SQLSTATE RS001 -> fare is missing or not greater than 0     (added in assignment 2)
--   SQLSTATE RS002 -> vehicle not found                         (added in assignment 2)
--   SQLSTATE RS003 -> vehicle is not active                     (added in assignment 2)
--   SQLSTATE RS004 -> rider not found                           (added in assignment 2)

CREATE OR REPLACE PROCEDURE book_trip(
    p_rider_id    UUID,
    p_vehicle_id  UUID,
    p_fare_amount DECIMAL(10,2),
    INOUT p_trip_id UUID DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_vehicle_active BOOLEAN;
BEGIN
    -- (added in assignment 2) input checks with our own SQLSTATEs, so the API can
    -- tell the cases apart without parsing message text. before this, a booking
    -- on a deactivated vehicle went through, and a zero fare created a trip with
    -- no audit row.
    IF p_fare_amount IS NULL OR p_fare_amount <= 0 THEN
        RAISE EXCEPTION 'book_trip: fare must be greater than 0'
            USING ERRCODE = 'RS001';
    END IF;

    -- FOR SHARE: nobody can deactivate or delete the vehicle until we commit
    SELECT is_active INTO v_vehicle_active
    FROM vehicles WHERE id = p_vehicle_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_trip: vehicle % not found', p_vehicle_id
            USING ERRCODE = 'RS002';
    END IF;

    IF NOT v_vehicle_active THEN
        RAISE EXCEPTION 'book_trip: vehicle % is not active', p_vehicle_id
            USING ERRCODE = 'RS003';
    END IF;

    -- tag the upcoming wallet_balance decrease as ESCROW (not a plain DEBIT) for
    -- the step-2 audit trigger. SET LOCAL/is_local so it only applies to this
    -- transaction and never leaks onto a pooled connection.
    SET LOCAL ridesync.wallet_action_type = 'ESCROW';

    -- move the fare into escrow. if this would take wallet_balance below 0, the
    -- CHECK constraint on riders raises check_violation right here, before the
    -- trip is ever inserted, and the whole CALL rolls back automatically.
    UPDATE riders
    SET wallet_balance = wallet_balance - p_fare_amount
    WHERE id = p_rider_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_trip: rider % not found', p_rider_id
            USING ERRCODE = 'RS004';
    END IF;

    -- idx_active_rider_trip (partial unique index, step 2) will reject this insert
    -- if the rider already has a REQUESTED/IN_TRANSIT trip -- same rollback behavior.
    INSERT INTO trips (rider_id, vehicle_id, fare_amount, status)
    VALUES (p_rider_id, p_vehicle_id, p_fare_amount, 'REQUESTED')
    RETURNING id INTO p_trip_id;

    COMMIT;
END;
$$;
