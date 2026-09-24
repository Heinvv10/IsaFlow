-- 698: the practice columns the code reads and writes, on every database.
--
-- R-121. Practice time capture writes columns that not every database has:
--   - createPracticeEntry / updatePracticeEntry write time_entries.amount,
--     which no migration creates;
--   - createClientRateOverride writes, and resolveRate / migration 626's mirror
--     trigger read, practice_client_rate_overrides.user_id and .rate. Migration
--     372 creates them, but on a database whose table predates 372 (its CREATE
--     TABLE IF NOT EXISTS skipped) only 395's staff_user_id / rate_per_hour
--     exist. The schema fixture (a production schema dump of 2026-09-08) and
--     isaflow_dev are such databases: every practice time-entry and rate
--     override write there fails 42703.
--
-- Additive and idempotent: where a column exists this does nothing, so it is
-- safe whatever production's current shape is. The legacy pair is added
-- NULLABLE (372's NOT NULL would refuse the rows 395 wrote) and back-filled
-- from the pair every reader prefers; 626's trigger keeps them in step after.

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS amount NUMERIC(15,2);

ALTER TABLE practice_client_rate_overrides
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS rate NUMERIC(12,2);

UPDATE practice_client_rate_overrides
SET user_id = COALESCE(user_id, staff_user_id),
    rate    = COALESCE(rate, rate_per_hour)
WHERE (user_id IS NULL AND staff_user_id IS NOT NULL)
   OR (rate IS NULL AND rate_per_hour IS NOT NULL);

-- The table's GRANTS and POLICY, like its siblings (practice_staff_rates, …).
-- On the same databases the table carried no grant for app_user,
-- platform_admin or migration_admin — every app read of it, resolveRate
-- included, and so every practice time entry, raised "permission denied".
-- And its policy (395) read a `company_id` JWT claim that only the MCP bearer
-- pipeline synthesises: withAuth passes the GoTrue token's own claims, which
-- carry none, so a web request saw zero rows and could insert none. The
-- standard tenant_isolation (348) keys on company_users and
-- app.current_company_id, which every pipeline sets.
GRANT SELECT, INSERT, UPDATE, DELETE ON practice_client_rate_overrides TO app_user, platform_admin;
GRANT ALL ON practice_client_rate_overrides TO migration_admin;

DROP POLICY IF EXISTS pcro_company_isolation ON practice_client_rate_overrides;
DROP POLICY IF EXISTS tenant_isolation ON practice_client_rate_overrides;
CREATE POLICY tenant_isolation ON practice_client_rate_overrides
  FOR ALL TO app_user
  USING (company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid()))
  WITH CHECK (company_id = app.current_company_id());
