-- 926: the medical scheme fees tax credit a run line's PAYE took into account
-- (PAYE 4a follow-ups round 2, R3), for the e@syFile certificate code 4116
-- "Medical Scheme Fees Tax Credit considered by employer for PAYE purposes"
-- (SARS BRS PAYE Employer Reconciliation V25.3.0, Jun-26, p. 59-60, 108).
--
-- Writer: calculatePayrollRun (payrollRunService -> payrollRunLineWriter), the
-- figure from payeCumulative: the credit inside the PAYE liability to date
-- less the credits the employee's earlier lines of the tax year recorded.
-- Reader: loadPayeYearToDate (payrollYearToDate.ts), which sums it for the
-- next line. A line written before this migration is NULL (recorded none);
-- the next line's record carries its credit.
--
-- One column only: IsaFlow does not compute the additional medical expenses
-- tax credit for 65 and older (4120), so there is nothing to store for it.
--
-- Additive only: one nullable column. Existing rows stay NULL.
--
-- Rollback:
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS medical_credit;
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS medical_credit NUMERIC(14,2);
