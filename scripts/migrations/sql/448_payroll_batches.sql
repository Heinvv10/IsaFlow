-- 448_payroll_batches.sql
-- Batch transaction entry for payroll (VIP-style "Batch Transactions" and
-- "Reimbursive Travel Transaction Batch"). A batch is a draft collection of
-- per-employee values that is validated, then posted as payroll_employee_components
-- rows in one transaction. Before posting, nothing hits the payslip calculation.
--
-- Two batch types share one schema:
--   - 'component_values' : pick a single component (e.g. "Bonus", "Overtime"),
--                          then enter (employee, value, recurring?, effective_from)
--                          for many employees.
--   - 'reimbursive_travel': capture km + rate per employee; the posting step
--                          splits into taxable (3702, above SARS rate) and
--                          non-taxable (3703, up to SARS rate) component
--                          assignments. meta.km and meta.rate_per_km are stored
--                          per line; component_id at batch level is ignored.

CREATE TABLE IF NOT EXISTS payroll_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_type TEXT NOT NULL CHECK (batch_type IN ('component_values', 'reimbursive_travel')),
  component_id UUID REFERENCES payroll_components(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'posted', 'cancelled')),
  line_count INTEGER NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_at TIMESTAMPTZ,
  posted_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_component_required
    CHECK (batch_type <> 'component_values' OR component_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_payroll_batches_company_status
  ON payroll_batches(company_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_batches_period
  ON payroll_batches(company_id, period_year, period_month);

CREATE TABLE IF NOT EXISTS payroll_batch_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES payroll_batches(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  value NUMERIC(14,2) NOT NULL DEFAULT 0,
  km NUMERIC(10,2),
  rate_per_km NUMERIC(10,4),
  taxable_portion NUMERIC(14,2),
  non_taxable_portion NUMERIC(14,2),
  effective_from DATE NOT NULL,
  effective_to DATE,
  notes TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_batch_lines_batch
  ON payroll_batch_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_payroll_batch_lines_employee
  ON payroll_batch_lines(employee_id);

COMMENT ON TABLE payroll_batches IS
  'Draft collections of per-employee component values, validated and posted in one transaction into payroll_employee_components. Unposted batches do not affect payroll runs.';
COMMENT ON COLUMN payroll_batches.is_recurring IS
  'Default recurring flag applied to every resulting payroll_employee_components row. Most batches are once-off (default false).';
COMMENT ON COLUMN payroll_batch_lines.km IS
  'Reimbursive travel only: km travelled this period. NULL for component_values batches.';
COMMENT ON COLUMN payroll_batch_lines.rate_per_km IS
  'Reimbursive travel only: rand per km paid to employee. NULL for component_values batches.';
COMMENT ON COLUMN payroll_batch_lines.taxable_portion IS
  'Reimbursive travel only: km * MAX(0, rate - SARS prescribed rate). Posts to SARS code 3702.';
COMMENT ON COLUMN payroll_batch_lines.non_taxable_portion IS
  'Reimbursive travel only: km * MIN(rate, SARS prescribed rate). Posts to SARS code 3703.';
