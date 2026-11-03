-- 948: retirement fund contributions in PAYE (PAYE 4c, section 11F).
--
-- payroll_run_lines.retirement_contributions: the employee's contributions on
-- the line, deductions coded 4001 (pension), 4003 (provident) or 4006
-- (retirement annuity) (SARS BRS PAYE Employer Reconciliation V25.3.0,
-- Jun-26, p. 101-102). retirement_deduction: the deduction inside the PAYE
-- liability to date less what the employee's earlier lines of the tax year
-- recorded (payeCumulative.ts; the lesser of the cap and 27.5% of
-- remuneration, SARS PAYE-GEN-01-G21 (2027) p. 10). periodic_taxable /
-- annual_taxable (913) and taxable_income hold remuneration BEFORE this
-- deduction (never negative). Writer: calculatePayrollRun (payrollRunService ->
-- payrollRunLineWriter). Reader: loadPayeYearToDate (payrollYearToDate.ts)
-- through payrollRetirementRecord, which sums both for the next line's
-- cumulative cap. A line written before this migration is NULL: its
-- contributions are read from its breakdown.
--
-- payroll_components.paid_outside_payroll: a retirement fund contribution the
-- employee pays the fund directly (a "private RA"): counted for the s11F
-- deduction and the certificate's 4001/4003/4006, never deducted from pay, so
-- it is not in net pay, total deductions or the 2175 journal line
-- (payrollCalculator). Only a deduction coded 4001/4003/4006 may carry it
-- (the CHECK; the code is trimmed of ASCII space/tab/CR/LF as
-- normaliseSarsCode does). Explicit default false: every existing component
-- stays as it is, so the CHECK holds for every existing row. The component
-- route refuses the rest with a 400 (retirementFund.paidOutsidePayrollRefusal).
--
-- Additive only: three columns and one CHECK; no data is rewritten.
--
-- Rollback:
--   ALTER TABLE payroll_components DROP CONSTRAINT IF EXISTS payroll_components_paid_outside_payroll_check;
--   ALTER TABLE payroll_components DROP COLUMN IF EXISTS paid_outside_payroll;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS retirement_deduction;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS retirement_contributions;
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS retirement_contributions NUMERIC(14,2);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS retirement_deduction NUMERIC(14,2);

ALTER TABLE payroll_components ADD COLUMN IF NOT EXISTS paid_outside_payroll BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_components_paid_outside_payroll_check'
      AND conrelid = 'public.payroll_components'::regclass
  ) THEN
    ALTER TABLE payroll_components ADD CONSTRAINT payroll_components_paid_outside_payroll_check CHECK (
      NOT paid_outside_payroll
      OR (component_type = 'deduction'
          AND regexp_replace(sars_source_code, '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') IN ('4001', '4003', '4006'))
    );
  END IF;
END $$;
