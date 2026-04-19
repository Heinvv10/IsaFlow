-- 372_practice_staff_rates.sql
-- Staff billing rate history with client-level overrides

CREATE TABLE IF NOT EXISTS practice_staff_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL,
  user_id        UUID NOT NULL,
  rate           NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  currency       TEXT NOT NULL DEFAULT 'ZAR',
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_psr_dates CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_psr_user ON practice_staff_rates(company_id, user_id, effective_from);

CREATE TABLE IF NOT EXISTS practice_client_rate_overrides (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL,
  client_id      UUID NOT NULL REFERENCES practice_clients(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL,
  rate           NUMERIC(12,2) NOT NULL CHECK (rate >= 0),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_pcro_dates CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_pcro_client_user ON practice_client_rate_overrides(company_id, client_id, user_id, effective_from);
