-- 495: External payslip imports for the payroll parallel-run comparison
-- (Dotbiz Workstream C). An import is one external (Sage/VIP) payslip dataset
-- for one period; payslip amounts are stored in integer CENTS so cent-level
-- comparison never touches floats.

CREATE TABLE IF NOT EXISTS payroll_external_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_month    INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year     INT NOT NULL CHECK (period_year >= 2020),
  source          VARCHAR(100) NOT NULL DEFAULT 'external',
  file_name       VARCHAR(255),
  payslip_count   INT NOT NULL DEFAULT 0,
  components_present JSONB NOT NULL DEFAULT '[]',
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_external_imports_company
  ON payroll_external_imports (company_id, period_year, period_month);

CREATE TABLE IF NOT EXISTS payroll_external_payslips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id         UUID NOT NULL REFERENCES payroll_external_imports(id) ON DELETE CASCADE,
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_number   VARCHAR(50) NOT NULL,
  employee_name     VARCHAR(255),
  gross_cents        BIGINT,
  paye_cents         BIGINT,
  uif_employee_cents BIGINT,
  uif_employer_cents BIGINT,
  uif_total_cents    BIGINT,
  sdl_cents          BIGINT,
  eti_cents          BIGINT,
  net_cents          BIGINT,
  UNIQUE (import_id, employee_number)
);

CREATE INDEX IF NOT EXISTS idx_payroll_external_payslips_import
  ON payroll_external_payslips (import_id);
CREATE INDEX IF NOT EXISTS idx_payroll_external_payslips_company
  ON payroll_external_payslips (company_id);
