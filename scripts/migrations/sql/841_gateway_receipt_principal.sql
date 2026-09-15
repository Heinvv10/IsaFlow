-- 841: the unattended principal a payment-gateway settlement posts under.
--
-- A Paystack card payment is confirmed by `confirmCustomerPayment`, a
-- controlled AR operation, from a public webhook that authenticates a
-- signature rather than a person. There is no human actor and there never will
-- be one, so the receipt is attributed to a reserved identity instead of to a
-- borrowed company member — a reader of `control_change_events` or of a
-- journal's `created_by` must never be shown someone who did not do it.
--
-- Two things are needed for that identity to be legible:
--   * `provenance` must be able to SAY 'gateway'. 'job' already means an audit
--     worker running under a named person's delegated authority, which this is
--     not; reusing it would make the evidence lie by a synonym.
--   * the reserved person must resolve to a name wherever the UI joins users,
--     so it reads "Paystack gateway" rather than an unresolved UUID.

DO $$
DECLARE v_name text;
BEGIN
  SELECT conname INTO v_name FROM pg_constraint
  WHERE conrelid = 'control_change_events'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%provenance%';
  IF v_name IS NOT NULL AND pg_get_constraintdef(
      (SELECT oid FROM pg_constraint WHERE conname = v_name
         AND conrelid = 'control_change_events'::regclass)) NOT LIKE '%gateway%' THEN
    EXECUTE format('ALTER TABLE control_change_events DROP CONSTRAINT %I', v_name);
    v_name := NULL;
  END IF;
  IF v_name IS NULL THEN
    ALTER TABLE control_change_events
      ADD CONSTRAINT control_change_events_provenance_check
      CHECK (provenance IN ('human','agent','job','gateway'));
  END IF;
END $$;

-- The account is never logged into: GoTrue owns authentication and there is no
-- matching identity there, and `is_active` is false. It exists only so the ledger
-- can name its author.
--
-- No `password_hash`: migration 349 dropped that column at the GoTrue cutover, so
-- naming it here failed at PARSE (`column "password_hash" of relation "users" does
-- not exist`) and `ON CONFLICT` could not save it. This file had never been applied
-- to any database until the rebuilt integration fixture ran it.
INSERT INTO users (id, email, first_name, last_name, role, is_active)
VALUES ('00000000-0000-4000-8000-000000000001', 'paystack-gateway@system.isaflow.co.za',
        'Paystack', 'gateway', 'system', false)
ON CONFLICT (id) DO NOTHING;
