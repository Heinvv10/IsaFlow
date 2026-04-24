-- 449_payroll_loans.sql
-- Employee loan module. Closes the "Loan Module" gap in the VIP parity list.
--
-- Architecture:
--   payroll_loans          — one row per loan (the header / agreement)
--   payroll_loan_schedule  — expected amortisation rows, generated at create
--                            time. Periodic recalc regenerates from the
--                            current unpaid position.
--   payroll_loan_payments  — actual deductions applied by a payroll run.
--                            One row per (loan, run).
--
-- SARS fringe-benefit treatment (Seventh Schedule §7):
--   When the effective loan rate < official rate (REPO+1%) for the period,
--   the shortfall * outstanding balance is taxable fringe benefit on SARS
--   source code 3801 ("Use of an asset"). Captured as fringe_benefit on
--   payroll_loan_payments so downstream IRP5 summaries pick it up via the
--   existing payroll_employee_components path (component with SARS 3801).

CREATE TABLE IF NOT EXISTS payroll_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE RESTRICT,
  loan_number TEXT NOT NULL,
  description TEXT NOT NULL,
  principal NUMERIC(14,2) NOT NULL CHECK (principal > 0),
  annual_interest_rate NUMERIC(6,4) NOT NULL DEFAULT 0 CHECK (annual_interest_rate >= 0),
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 600),
  method TEXT NOT NULL CHECK (method IN ('declining_balance', 'straight_line', 'interest_free')),
  start_date DATE NOT NULL,
  first_deduction_period_year INTEGER NOT NULL,
  first_deduction_period_month INTEGER NOT NULL CHECK (first_deduction_period_month BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'written_off', 'cancelled')),
  outstanding_balance NUMERIC(14,2) NOT NULL,
  total_interest_charged NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_principal_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  UNIQUE (company_id, loan_number)
);

CREATE INDEX IF NOT EXISTS idx_payroll_loans_company_status
  ON payroll_loans(company_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_loans_employee
  ON payroll_loans(employee_id);

CREATE TABLE IF NOT EXISTS payroll_loan_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES payroll_loans(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  due_period_year INTEGER NOT NULL,
  due_period_month INTEGER NOT NULL CHECK (due_period_month BETWEEN 1 AND 12),
  opening_balance NUMERIC(14,2) NOT NULL,
  interest NUMERIC(14,2) NOT NULL DEFAULT 0,
  principal NUMERIC(14,2) NOT NULL,
  installment NUMERIC(14,2) NOT NULL,
  closing_balance NUMERIC(14,2) NOT NULL,
  paid_flag BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loan_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_payroll_loan_schedule_due
  ON payroll_loan_schedule(loan_id, due_period_year, due_period_month);

CREATE TABLE IF NOT EXISTS payroll_loan_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES payroll_loans(id) ON DELETE CASCADE,
  run_id UUID REFERENCES payroll_run_headers(id) ON DELETE SET NULL,
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  opening_balance NUMERIC(14,2) NOT NULL,
  interest_charged NUMERIC(14,2) NOT NULL DEFAULT 0,
  principal_paid NUMERIC(14,2) NOT NULL,
  fringe_benefit NUMERIC(14,2) NOT NULL DEFAULT 0,
  closing_balance NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loan_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_payroll_loan_payments_run
  ON payroll_loan_payments(run_id);

COMMENT ON TABLE payroll_loans IS
  'Employee loan agreements. Balance is maintained as a running total in outstanding_balance. Schedule and payments tables give the full audit trail.';
COMMENT ON COLUMN payroll_loans.method IS
  'declining_balance = equal installments (interest re-calculated on outstanding); straight_line = equal principal each period + interest on outstanding; interest_free = principal only, fringe benefit if official rate > 0.';
COMMENT ON COLUMN payroll_loan_payments.fringe_benefit IS
  'SARS 3801 taxable value — (official_rate - loan_rate) * opening_balance / 12 when loan rate < official rate.';
