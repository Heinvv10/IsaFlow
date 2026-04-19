-- 381_payroll_components.sql
-- Component catalogue with SARS source codes; employee-level effective-date assignments.

CREATE TABLE IF NOT EXISTS payroll_components (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name              VARCHAR(100) NOT NULL,
  sars_source_code  VARCHAR(10) NOT NULL,
  component_type    VARCHAR(20) NOT NULL
    CHECK (component_type IN ('earning', 'deduction', 'employer_contribution')),
  is_taxable        BOOLEAN NOT NULL DEFAULT TRUE,
  is_uif_applicable BOOLEAN NOT NULL DEFAULT TRUE,
  is_sdl_applicable BOOLEAN NOT NULL DEFAULT TRUE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_payroll_components_company
  ON payroll_components (company_id);

CREATE TABLE IF NOT EXISTS payroll_employee_components (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  component_id  UUID NOT NULL REFERENCES payroll_components(id) ON DELETE RESTRICT,
  amount        NUMERIC(14,2) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_emp_components_employee
  ON payroll_employee_components (employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_emp_components_effective
  ON payroll_employee_components (employee_id, effective_from, effective_to);
