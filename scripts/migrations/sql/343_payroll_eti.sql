-- 343_payroll_eti.sql
-- Adds Employment Tax Incentive (ETI) fields. ETI offsets PAYE liability on EMP201.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS eti_employment_start_date DATE,
  ADD COLUMN IF NOT EXISTS eti_is_connected_person   BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS eti_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS eti_months  INTEGER       NOT NULL DEFAULT 0;

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS total_eti NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN employees.eti_employment_start_date IS 'Date of first qualifying employment with this employer for ETI 24-month window';
COMMENT ON COLUMN employees.eti_is_connected_person   IS 'If TRUE, employee is a connected person and NOT ETI-eligible';
COMMENT ON COLUMN payslips.eti_amount                 IS 'ETI earned for this month — reduces EMP201 PAYE liability (NOT a payslip deduction)';
COMMENT ON COLUMN payslips.eti_months                 IS 'Which month of the 24-month ETI window this payslip falls in (1-24)';
