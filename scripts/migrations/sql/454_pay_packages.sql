-- 454_pay_packages.sql
-- Reusable earning/deduction bundles. A package is a named list of
-- (component, default amount, recurring flag) rows; "apply to employee"
-- materialises them into payroll_employee_components with an
-- effective_from date. No FK from employee: assignments live on the
-- employee-component table, not here, so an applied package is a
-- point-in-time snapshot — later edits to the package don't propagate.

CREATE TABLE IF NOT EXISTS pay_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_pay_packages_company_active
  ON pay_packages(company_id, is_active);

CREATE TABLE IF NOT EXISTS pay_package_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES pay_packages(id) ON DELETE CASCADE,
  component_id UUID NOT NULL REFERENCES payroll_components(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  is_recurring BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (package_id, component_id)
);

CREATE INDEX IF NOT EXISTS idx_pay_package_components_package
  ON pay_package_components(package_id);

COMMENT ON TABLE pay_packages IS
  'Reusable earning/deduction bundles. Applied to employees via a service call that materialises the package rows into payroll_employee_components; package edits do not retroactively change prior applications.';
