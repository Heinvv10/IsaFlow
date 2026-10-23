-- 913: a run line's taxable income split into periodic pay and annual payments
-- (PAYE 4a follow-ups G4, cumulative PAYE).
--
-- The cumulative PAYE of a period needs the employee's earlier periods of the
-- tax year: periodic taxable remuneration and annual payments (3605)
-- separately (payeCumulative.ts). taxable_income holds their sum. Writer:
-- calculatePayrollRun (payrollRunService). Reader: loadPayeYearToDate
-- (payrollYearToDate.ts), which derives the split for a line written before
-- this migration (NULL here) from its stored breakdown.
--
-- Additive only: two nullable columns. Existing rows stay NULL.
--
-- Rollback:
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS annual_taxable;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS periodic_taxable;
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS periodic_taxable NUMERIC(14,2);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS annual_taxable NUMERIC(14,2);
