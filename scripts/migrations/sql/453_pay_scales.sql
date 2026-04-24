-- 453_pay_scales.sql
-- Salary grade master + FK on payroll_employees.
--
-- A pay scale is a (min, mid, max) band with a numeric grade level for
-- ordering (1 = junior, higher = senior). Assigning an employee to a
-- scale is purely informational — we don't force the actual salary into
-- the band, but reports and UI will flag out-of-band employees so
-- comp-review discussions are data-driven.

CREATE TABLE IF NOT EXISTS pay_scales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  grade_level INTEGER NOT NULL DEFAULT 0,
  min_salary NUMERIC(14,2) NOT NULL CHECK (min_salary >= 0),
  mid_salary NUMERIC(14,2) NOT NULL CHECK (mid_salary >= 0),
  max_salary NUMERIC(14,2) NOT NULL CHECK (max_salary >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'ZAR',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code),
  CHECK (min_salary <= mid_salary AND mid_salary <= max_salary)
);

CREATE INDEX IF NOT EXISTS idx_pay_scales_company_active
  ON pay_scales(company_id, is_active);

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS pay_scale_id UUID REFERENCES pay_scales(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_employees_pay_scale
  ON payroll_employees(pay_scale_id);

COMMENT ON TABLE pay_scales IS
  'Salary grade master. Assignment is advisory — reports flag employees whose actual salary falls outside [min, max] but the system does not prevent it.';
