-- 383_payroll_leave.sql
-- BCEA-compliant leave types, balances, and requests.

CREATE TABLE IF NOT EXISTS payroll_leave_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  bcea_type       VARCHAR(30)
    CHECK (bcea_type IN ('annual', 'sick', 'family_responsibility', 'maternity', 'paternity', 'unpaid', 'study', 'other')),
  accrual_rule    VARCHAR(20) NOT NULL DEFAULT 'monthly'
    CHECK (accrual_rule IN ('monthly', 'cycle_30_per_36', 'none')),
  accrual_days    NUMERIC(5,2) NOT NULL DEFAULT 1.25,
  max_carry_over  NUMERIC(5,2),
  is_paid         BOOLEAN NOT NULL DEFAULT TRUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plt_company ON payroll_leave_types (company_id);

CREATE TABLE IF NOT EXISTS payroll_leave_balances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  leave_type_id   UUID NOT NULL REFERENCES payroll_leave_types(id) ON DELETE RESTRICT,
  balance_year    INT NOT NULL,
  accrued         NUMERIC(6,2) NOT NULL DEFAULT 0,
  taken           NUMERIC(6,2) NOT NULL DEFAULT 0,
  pending         NUMERIC(6,2) NOT NULL DEFAULT 0,
  balance         NUMERIC(6,2) GENERATED ALWAYS AS (accrued - taken - pending) STORED,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, leave_type_id, balance_year)
);

CREATE INDEX IF NOT EXISTS idx_plb_employee ON payroll_leave_balances (employee_id);

CREATE TABLE IF NOT EXISTS payroll_leave_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  leave_type_id   UUID NOT NULL REFERENCES payroll_leave_types(id) ON DELETE RESTRICT,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  days            NUMERIC(5,2) NOT NULL,
  reason          TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plr_employee ON payroll_leave_requests (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_leave_requests_leave_type
  ON payroll_leave_requests (leave_type_id);
