-- 450_cost_centres.sql
-- Normalized cost centres. payroll_employees had a free-text `cost_centre`
-- column (mig 380) which worked for single-employee payslip display but
-- made cross-employee reporting impossible (typos, case differences etc.
-- fragmented the list). This migration introduces a proper master table,
-- adds a FK on payroll_employees, and back-fills from the existing text.
--
-- The text column is left in place as a historical record; going forward
-- the FK is authoritative. UI writes to both until the free-text field
-- is removed in a later migration.

CREATE TABLE IF NOT EXISTS cost_centres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_cost_centres_company_active
  ON cost_centres(company_id, is_active);

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS cost_centre_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_employees_cost_centre
  ON payroll_employees(cost_centre_id);

-- Backfill: for every (company_id, non-empty cost_centre) pair found on
-- payroll_employees, insert one master row using the text as both code
-- and name, then point the employee at it. Idempotent via the UNIQUE
-- (company_id, code) constraint.
INSERT INTO cost_centres (company_id, code, name)
SELECT DISTINCT company_id, TRIM(cost_centre), TRIM(cost_centre)
  FROM payroll_employees
 WHERE cost_centre IS NOT NULL
   AND TRIM(cost_centre) <> ''
ON CONFLICT (company_id, code) DO NOTHING;

UPDATE payroll_employees e
   SET cost_centre_id = cc.id
  FROM cost_centres cc
 WHERE cc.company_id = e.company_id
   AND cc.code = TRIM(e.cost_centre)
   AND e.cost_centre_id IS NULL
   AND e.cost_centre IS NOT NULL
   AND TRIM(e.cost_centre) <> '';

COMMENT ON TABLE cost_centres IS
  'Normalized cost centre master. Replaces free-text payroll_employees.cost_centre — the text column is retained for audit but all new reporting should join via cost_centre_id.';
