-- 451_payroll_employee_cost_allocations.sql
-- Per-employee cost-allocation splits. Phase 4 (mig 450) assumed each
-- employee belongs to exactly one cost centre; real businesses routinely
-- split a salary across two or more centres (e.g. 60% ADMIN / 40% PROJECTS).
--
-- Design:
--   - Rows in this table, when present for an employee, OVERRIDE the
--     payroll_employees.cost_centre_id single-centre FK for cost-centre
--     reporting. cost_centre_id is left in place so existing consumers
--     that join directly keep working.
--   - Percentages are stored as NUMERIC(5,2) with a row-level CHECK
--     (0 < percentage <= 100). The sum-to-100% invariant is enforced at
--     the application layer (transactional DELETE + INSERT in one tx);
--     a PL/pgSQL constraint would prevent mid-transaction partial rows.
--   - (company_id, employee_id, cost_centre_id) is the natural key — an
--     employee never has two allocations to the same centre.

CREATE TABLE IF NOT EXISTS payroll_employee_cost_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  cost_centre_id UUID NOT NULL REFERENCES cost_centres(id) ON DELETE RESTRICT,
  percentage NUMERIC(5,2) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, employee_id, cost_centre_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_emp_cost_alloc_employee
  ON payroll_employee_cost_allocations(employee_id);

CREATE INDEX IF NOT EXISTS idx_payroll_emp_cost_alloc_cc
  ON payroll_employee_cost_allocations(cost_centre_id);

COMMENT ON TABLE payroll_employee_cost_allocations IS
  'Per-employee cost-centre percentage splits. When present for an employee, overrides payroll_employees.cost_centre_id for cost-centre reporting. Sum of percentages for a single (company_id, employee_id) must equal 100 — enforced at application layer in a single transaction.';
