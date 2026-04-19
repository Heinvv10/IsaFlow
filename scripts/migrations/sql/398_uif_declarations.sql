-- Migration 397: UIF Declarations (UI-19 monthly filing)
-- Monthly UIF declaration records per company / period

CREATE TABLE IF NOT EXISTS uif_declarations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID NOT NULL REFERENCES companies(id),
  period_year               INT NOT NULL,
  period_month              INT NOT NULL,
  uif_reference             VARCHAR(20),
  total_employees           INT NOT NULL DEFAULT 0,
  total_leviable_salary     NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_employee_contribution NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_employer_contribution NUMERIC(15,2) NOT NULL DEFAULT 0,
  status                    VARCHAR(20) NOT NULL DEFAULT 'draft',
  submitted_at              TIMESTAMPTZ,
  submitted_by              UUID,
  notes                     TEXT,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS uif_declarations_company_period_idx
  ON uif_declarations(company_id, period_year DESC, period_month DESC);
