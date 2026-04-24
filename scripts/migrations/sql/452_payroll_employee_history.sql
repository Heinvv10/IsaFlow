-- 452_payroll_employee_history.sql
-- Employee change history for audit + effective-dated reporting. Captures
-- per-field transitions (old → new) with an effective_from date and the
-- user + optional reason.
--
-- Seed fields tracked: department, cost_centre_id, employment_type.
-- Other fields can be added later without a schema change — field_name
-- is a free-text TEXT column.
--
-- effective_from defaults to the recording timestamp's date but can be
-- back-dated (or forward-dated) by callers — needed for "effective 1 April"
-- promotions logged mid-month.

CREATE TABLE IF NOT EXISTS payroll_employee_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  change_reason TEXT,
  changed_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (old_value IS DISTINCT FROM new_value)
);

CREATE INDEX IF NOT EXISTS idx_payroll_emp_history_emp_eff
  ON payroll_employee_history(employee_id, effective_from DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payroll_emp_history_company_field
  ON payroll_employee_history(company_id, field_name);

COMMENT ON TABLE payroll_employee_history IS
  'Per-field employee change log. old_value/new_value stored as TEXT regardless of source column type — reader interprets by field_name. effective_from supports back-/forward-dated changes independent of created_at.';
