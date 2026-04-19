-- 386_practice_staff_cost_rates.sql
-- Staff cost rates with effective-date history. Used for margin calc on Client Profitability.
-- Distinct from practice_staff_rates (billing rates).

CREATE TABLE IF NOT EXISTS practice_staff_cost_rates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id),
  user_id            UUID NOT NULL,
  cost_rate          NUMERIC(18,4) NOT NULL CHECK (cost_rate >= 0),
  currency           TEXT NOT NULL DEFAULT 'ZAR',
  effective_from     DATE NOT NULL,
  effective_to       DATE,
  notes              TEXT,
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_pscr_company_user ON practice_staff_cost_rates(company_id, user_id);
CREATE INDEX IF NOT EXISTS idx_pscr_user_effective ON practice_staff_cost_rates(user_id, effective_from);
