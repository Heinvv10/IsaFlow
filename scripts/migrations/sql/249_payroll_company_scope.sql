-- Add company_id to payroll tables for multi-tenant data isolation

-- ── employees ────────────────────────────────────────────────────────────────

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS company_id UUID;

-- Back-fill existing rows with the first company (single-tenant legacy data)
UPDATE employees
SET company_id = (SELECT id FROM companies ORDER BY created_at ASC LIMIT 1)
WHERE company_id IS NULL;

-- Make NOT NULL after back-fill
ALTER TABLE employees
  ALTER COLUMN company_id SET NOT NULL;

-- Drop the old unique constraint on employee_number (it's now per-company)
ALTER TABLE employees
  DROP CONSTRAINT IF EXISTS employees_employee_number_key;

-- Add a unique constraint scoped to company
ALTER TABLE employees
  ADD CONSTRAINT employees_company_employee_number_unique
    UNIQUE (company_id, employee_number);

CREATE INDEX IF NOT EXISTS idx_employees_company_id ON employees (company_id);

-- ── payroll_runs ─────────────────────────────────────────────────────────────

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS company_id UUID;

UPDATE payroll_runs
SET company_id = (SELECT id FROM companies ORDER BY created_at ASC LIMIT 1)
WHERE company_id IS NULL;

ALTER TABLE payroll_runs
  ALTER COLUMN company_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_company_id ON payroll_runs (company_id);
