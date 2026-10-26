-- 948: the retirement fund contributions on a run line, and the deduction its
-- PAYE took into account (PAYE 4c, section 11F).
--
-- retirement_contributions: the employee's contributions on the line,
-- deductions coded 4001 (pension), 4003 (provident) or 4006 (retirement
-- annuity) (SARS BRS PAYE Employer Reconciliation V25.3.0, Jun-26,
-- p. 101-102). retirement_deduction: the deduction inside the PAYE liability
-- to date less what the employee's earlier lines of the tax year recorded
-- (payeCumulative.ts; the lesser of the cap and 27.5% of remuneration, SARS
-- PAYE-GEN-01-G21 (2027) p. 10). periodic_taxable / annual_taxable (913) now
-- hold remuneration BEFORE this deduction; taxable_income after it.
--
-- Writer: calculatePayrollRun (payrollRunService -> payrollRunLineWriter).
-- Reader: loadPayeYearToDate (payrollYearToDate.ts), which sums both for the
-- next line's cumulative cap. A line written before this migration is NULL
-- (read as none).
--
-- Additive only: two nullable columns. Existing rows stay NULL.
--
-- Rollback:
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS retirement_deduction;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS retirement_contributions;
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS retirement_contributions NUMERIC(14,2);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS retirement_deduction NUMERIC(14,2);
