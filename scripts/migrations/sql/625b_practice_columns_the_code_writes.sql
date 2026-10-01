-- 625b: the practice columns the code reads and writes, on every database.
--
-- Numbered BEFORE 626 on purpose: 626's mirror trigger and its back-fill
-- reference user_id / rate, so on a database lacking them 626 raised 42703 and
-- the runner (which stops at the first failure) never reached anything later.
-- Where 626 has already applied (production) this file is new and runs later,
-- as a no-op.
--
-- R-121. Practice time capture writes columns that not every database has:
--   - createPracticeEntry / updatePracticeEntry write time_entries.amount,
--     which no migration creates;
--   - createClientRateOverride writes, and resolveRate / migration 626's mirror
--     trigger read, practice_client_rate_overrides.user_id and .rate. Migration
--     372 creates them, but on a database whose table predates 372 (its CREATE
--     TABLE IF NOT EXISTS skipped) only 395's staff_user_id / rate_per_hour
--     exist. isaflow_dev and the r112 test fixture (a dev schema dump) are such
--     databases: every practice time-entry and rate override write there
--     fails 42703.
--
-- Additive and idempotent: where a column exists this does nothing, so it is
-- safe whatever production's current shape is. The legacy pair is added
-- NULLABLE (372's NOT NULL would refuse the rows 395 wrote) and back-filled
-- from the pair every reader prefers; 626's trigger keeps them in step after.

-- (18,2), the precision of line_total, which it duplicates.
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS amount NUMERIC(18,2);

ALTER TABLE practice_client_rate_overrides
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS rate NUMERIC(12,2);

UPDATE practice_client_rate_overrides
SET user_id = COALESCE(user_id, staff_user_id),
    rate    = COALESCE(rate, rate_per_hour)
WHERE (user_id IS NULL AND staff_user_id IS NOT NULL)
   OR (rate IS NULL AND rate_per_hour IS NOT NULL);
