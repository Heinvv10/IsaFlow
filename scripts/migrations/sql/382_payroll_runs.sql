-- 382_payroll_runs.sql
-- New company-scoped payroll run headers + per-employee run lines.

CREATE TABLE IF NOT EXISTS payroll_run_headers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL,
  period_month    INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year     INT NOT NULL CHECK (period_year >= 2020),
  status          VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'calculated', 'approved', 'paid', 'cancelled')),
  run_date        DATE,
  total_gross     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_taxable   NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_paye      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_uif       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_sdl       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_eti       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_net       NUMERIC(14,2) NOT NULL DEFAULT 0,
  employee_count  INT NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_prh_company
  ON payroll_run_headers (company_id);
CREATE INDEX IF NOT EXISTS idx_prh_period
  ON payroll_run_headers (company_id, period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_prh_status
  ON payroll_run_headers (company_id, status);

CREATE TABLE IF NOT EXISTS payroll_run_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES payroll_run_headers(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE RESTRICT,
  gross_pay       NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxable_income  NUMERIC(14,2) NOT NULL DEFAULT 0,
  paye            NUMERIC(14,2) NOT NULL DEFAULT 0,
  uif_employee    NUMERIC(14,2) NOT NULL DEFAULT 0,
  uif_employer    NUMERIC(14,2) NOT NULL DEFAULT 0,
  sdl             NUMERIC(14,2) NOT NULL DEFAULT 0,
  eti             NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay         NUMERIC(14,2) NOT NULL DEFAULT 0,
  component_breakdown JSONB NOT NULL DEFAULT '[]',
  validation_results  JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_prl_run
  ON payroll_run_lines (run_id);
CREATE INDEX IF NOT EXISTS idx_prl_employee
  ON payroll_run_lines (employee_id);
