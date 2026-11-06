-- 959: the s18A receipt an employer holds, and what each payroll line allowed for donations (code 4030).
--
-- SARS PAYE-GEN-01-G21 (2027) Rev 1 "Donations" (Fourth Schedule para 2(4)(f); s18A(2)(a)): the deduction may not
-- exceed 5% of remuneration after pension, provident and retirement annuity fund contributions, and is only
-- allowed if the employee has provided the employer with a receipt. Worked out cumulatively over the tax year
-- (s18aDonation.ts), so each line stores its share.
--
--   payroll_employees.s18a_receipt_held   the employer holds the employee's s18A receipt. Default false: no
--                                         receipt on record, no deduction (Hein 2026-11-06).
--   payroll_run_lines.donation_receipted  4030 on the line counted toward the limit (signed)
--   payroll_run_lines.donation_base       the line's remuneration less its retirement deduction
--   payroll_run_lines.donation_deduction  the deduction the line allowed (signed)
--
-- Writers: updatePayrollEmployee / createPayrollEmployee; calculatePayrollRun (payrollRunService ->
-- payrollRunLineWriter), the only writer of payroll_run_lines. Reader: loadPayeYearToDate.
--
-- Additive only: no backfill. A line written before this is NULL in all three and stays as costed: it adds
-- nothing to the 5% sums (no credit, no clawback), and its 4030 is still added back to the s11F base.
--
-- Rollback:
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS donation_deduction;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS donation_base;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS donation_receipted;
--   ALTER TABLE payroll_employees DROP COLUMN IF EXISTS s18a_receipt_held;
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS s18a_receipt_held BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS donation_receipted NUMERIC(14,2);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS donation_base NUMERIC(14,2);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS donation_deduction NUMERIC(14,2);
