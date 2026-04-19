-- Migration 395: Practice client rate overrides
-- Per-staff-member billing rate overrides for a specific client.

CREATE TABLE IF NOT EXISTS practice_client_rate_overrides (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id),
  client_id      UUID NOT NULL REFERENCES practice_clients(id) ON DELETE CASCADE,
  staff_user_id  UUID NOT NULL,
  rate_per_hour  NUMERIC(10,2) NOT NULL CHECK (rate_per_hour >= 0),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, client_id, staff_user_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_pcro_company_client ON practice_client_rate_overrides(company_id, client_id);
CREATE INDEX IF NOT EXISTS idx_pcro_staff ON practice_client_rate_overrides(company_id, staff_user_id);

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
