-- Payroll Module Migration
-- SA Payroll with SARS tax tables, UIF, SDL support

-- ── Employees ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS employees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number VARCHAR(20) NOT NULL UNIQUE,
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  id_number     VARCHAR(13),
  tax_number    VARCHAR(20),
  start_date    DATE NOT NULL,
  termination_date DATE,
  bank_name     VARCHAR(100),
  bank_account_number VARCHAR(30),
  bank_branch_code VARCHAR(10),
  department    VARCHAR(100),
  position      VARCHAR(100),
  employment_type VARCHAR(20) NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent', 'contract', 'temporary')),
  pay_frequency VARCHAR(10) NOT NULL DEFAULT 'monthly'
    CHECK (pay_frequency IN ('monthly', 'weekly')),
  status        VARCHAR(10) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_status ON employees (status);
CREATE INDEX IF NOT EXISTS idx_employees_employee_number ON employees (employee_number);

-- ── Pay Structures ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pay_structures (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id                 UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  basic_salary                NUMERIC(12,2) NOT NULL DEFAULT 0,
  travel_allowance            NUMERIC(12,2) NOT NULL DEFAULT 0,
  housing_allowance           NUMERIC(12,2) NOT NULL DEFAULT 0,
  cell_allowance              NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_allowances            NUMERIC(12,2) NOT NULL DEFAULT 0,
  medical_aid_contribution    NUMERIC(12,2) NOT NULL DEFAULT 0,
  retirement_fund_contribution_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  custom_deductions           JSONB DEFAULT '[]'::JSONB,
  effective_from              DATE NOT NULL,
  effective_to                DATE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pay_structures_employee ON pay_structures (employee_id);
CREATE INDEX IF NOT EXISTS idx_pay_structures_effective ON pay_structures (effective_from, effective_to);

-- ── Payroll Runs ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  run_date            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status              VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'processing', 'completed', 'reversed')),
  total_gross         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_paye          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_uif_employee  NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_uif_employer  NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_sdl           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_net           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_company_cost  NUMERIC(14,2) NOT NULL DEFAULT 0,
  journal_entry_id    UUID,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON payroll_runs (status);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_period ON payroll_runs (period_start, period_end);

-- ── Payslips ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payslips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id    UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees(id),
  basic_salary      NUMERIC(12,2) NOT NULL DEFAULT 0,
  travel_allowance  NUMERIC(12,2) NOT NULL DEFAULT 0,
  housing_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,
  cell_allowance    NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_allowances  NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_pay         NUMERIC(12,2) NOT NULL DEFAULT 0,
  paye              NUMERIC(12,2) NOT NULL DEFAULT 0,
  uif_employee      NUMERIC(12,2) NOT NULL DEFAULT 0,
  uif_employer      NUMERIC(12,2) NOT NULL DEFAULT 0,
  sdl               NUMERIC(12,2) NOT NULL DEFAULT 0,
  medical_aid       NUMERIC(12,2) NOT NULL DEFAULT 0,
  retirement_fund   NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_deductions  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_deductions  NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_pay           NUMERIC(12,2) NOT NULL DEFAULT 0,
  ytd_gross         NUMERIC(14,2) NOT NULL DEFAULT 0,
  ytd_paye          NUMERIC(14,2) NOT NULL DEFAULT 0,
  ytd_uif           NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payslips_run ON payslips (payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payslips_employee ON payslips (employee_id);
