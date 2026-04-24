-- 455_payroll_employee_payment_method.sql
-- Track how each employee is paid. Needed by the cash pay register (coin
-- list) which filters for payment_method='cash' and splits net_pay
-- across ZAR denominations for the cash-handling team.

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(10) NOT NULL DEFAULT 'eft';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_employees_payment_method_check'
      AND conrelid = 'public.payroll_employees'::regclass
  ) THEN
    ALTER TABLE payroll_employees
      ADD CONSTRAINT payroll_employees_payment_method_check
      CHECK (payment_method IN ('eft', 'cash', 'cheque'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payroll_employees_payment_method
  ON payroll_employees(company_id, payment_method);
