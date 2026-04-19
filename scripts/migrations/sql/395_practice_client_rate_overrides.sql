-- Migration 395: Extend practice_client_rate_overrides for the new service signature
-- The table was first created in 372_practice_staff_rates.sql with columns
--   (user_id, rate). The new practiceClientRateOverrideService writes
--   (staff_user_id, rate_per_hour, notes) and expects updated_at. Add the new
--   columns non-destructively, back-fill from the legacy columns, then add
--   the staff index + RLS policy.

ALTER TABLE practice_client_rate_overrides
  ADD COLUMN IF NOT EXISTS staff_user_id UUID,
  ADD COLUMN IF NOT EXISTS rate_per_hour NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS notes         TEXT,
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ DEFAULT NOW();

-- Back-fill new columns from legacy ones
UPDATE practice_client_rate_overrides
   SET staff_user_id = user_id
 WHERE staff_user_id IS NULL;

UPDATE practice_client_rate_overrides
   SET rate_per_hour = rate
 WHERE rate_per_hour IS NULL;

CREATE INDEX IF NOT EXISTS idx_pcro_staff
  ON practice_client_rate_overrides(company_id, staff_user_id);

ALTER TABLE practice_client_rate_overrides ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'practice_client_rate_overrides'
      AND policyname = 'pcro_company_isolation'
  ) THEN
    CREATE POLICY pcro_company_isolation ON practice_client_rate_overrides
      USING (company_id = (SELECT (current_setting('request.jwt.claims', true)::jsonb->>'company_id')::uuid));
  END IF;
END $$;
