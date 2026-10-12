-- RideSync project 2, step 2
-- trigger: whenever riders.wallet_balance changes, insert one row into wallet_audit_logs.
-- wallet_audit_logs is insert-only and this trigger is its only writer (per README).

-- action_type is normally inferred from the sign of the change:
--   balance went down -> DEBIT
--   balance went up   -> CREDIT
-- ESCROW is a special case: step 3's checkout procedure moves money into escrow, which
-- is still a decrease in wallet_balance, but it isn't a plain DEBIT. Rather than adding
-- an escrow table (README says we're not doing that), the procedure can tag the update
-- by setting a session-local GUC right before the UPDATE, e.g.:
--     SET LOCAL ridesync.wallet_action_type = 'ESCROW';
--     UPDATE riders SET wallet_balance = wallet_balance - :amount WHERE id = :rider_id;
-- If that setting isn't present (the normal case), the trigger falls back to DEBIT/CREDIT
-- based on the sign of the change. The setting only affects the current transaction.

CREATE OR REPLACE FUNCTION fn_wallet_audit_log()
RETURNS TRIGGER AS $$
DECLARE
    v_delta       DECIMAL(10,2);
    v_action_type VARCHAR(16);
BEGIN
    v_delta := NEW.wallet_balance - OLD.wallet_balance;

    -- no real change (e.g. UPDATE ran but set the same value) -> nothing to log
    IF v_delta = 0 THEN
        RETURN NEW;
    END IF;

    -- optional override set by the caller for this transaction only; NULL if unset
    v_action_type := NULLIF(current_setting('ridesync.wallet_action_type', true), '');

    IF v_action_type IS NULL THEN
        IF v_delta < 0 THEN
            v_action_type := 'DEBIT';
        ELSE
            v_action_type := 'CREDIT';
        END IF;
    END IF;

    -- (assignment 2) clock_timestamp() instead of the column default NOW(). NOW() is the
    -- transaction start time, so two wallet changes for one rider inside the same
    -- transaction got identical timestamps and the audit trail could not be put in order.
    INSERT INTO wallet_audit_logs (rider_id, amount_changed, action_type, balance_after, "timestamp")
    VALUES (NEW.id, v_delta, v_action_type, NEW.wallet_balance, clock_timestamp());

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallet_audit_log ON riders;

CREATE TRIGGER trg_wallet_audit_log
    AFTER UPDATE OF wallet_balance ON riders
    FOR EACH ROW
    WHEN (OLD.wallet_balance IS DISTINCT FROM NEW.wallet_balance)
    EXECUTE FUNCTION fn_wallet_audit_log();

-- ---------------------------------------------------------------------------
-- added in assignment 2 (see docs/handover_note.md)
-- the README says wallet_audit_logs is insert-only, but nothing enforced it:
-- UPDATE and DELETE on the table both succeeded. this makes it append-only.
-- (TRUNCATE is still allowed on purpose, the seeder's --reset uses it.)

CREATE OR REPLACE FUNCTION fn_wallet_audit_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'wallet_audit_logs is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'RS900';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallet_audit_immutable ON wallet_audit_logs;

CREATE TRIGGER trg_wallet_audit_immutable
    BEFORE UPDATE OR DELETE ON wallet_audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION fn_wallet_audit_immutable();
