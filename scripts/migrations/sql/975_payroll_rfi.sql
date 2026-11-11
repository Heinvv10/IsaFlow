-- 975: Retirement-funding income (RFI) as a fund's contribution base (wave 5, PR RF).
--
-- A retirement fund's rules usually set contributions as a percentage of the member's "retirement-funding income": the
-- pensionable part of the package (basic salary, and whatever else the fund's rules name). RFI is ONLY the fund's
-- contribution base. It is never a tax limit: since 1 March 2016 the s11F deduction is the lesser of R430 000 (2027)
-- and 27.5% of the higher of remuneration or taxable income (PAYE-GEN-01-G21 (2027) Rev 1 p. 10), whatever RFI is.
--
--   payroll_components.counts_as_rfi: the earning is part of RFI. Earnings only (CHECK). Backfilled TRUE for every
--     earning coded 3601 (basic salary, after the calculator's trim), deterministically and idempotently: no other row
--     changes, and a re-run changes nothing. No figure moves on deploy: the flag is read only to cost a percent_of_rfi
--     assignment, and none exists before this migration.
--   payroll_employee_components.percent_of_rfi: the assignment costs round2(percent x RFI) in each run (rfi.ts), as a
--     fraction (0.075 = 7.5%), more than 0 and at most 1. Such a row stores amount 0: the run decides the figure. The
--     service allows it only on a retirement contribution (deduction 4001 / 4003 / 4006) or an employer's fund
--     contribution (earning 3817 / 3825 / 3828).
--
-- Both are new columns with constant defaults (no table rewrite); the CHECKs are added NOT VALID then validated, each
-- only when absent, so a re-run is a no-op.

SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_components ADD COLUMN IF NOT EXISTS counts_as_rfi BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE payroll_components
   SET counts_as_rfi = TRUE
 WHERE component_type = 'earning'
   AND btrim(sars_source_code, E' \t\r\n') = '3601'
   AND counts_as_rfi = FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_components_rfi_earning_only') THEN
    ALTER TABLE payroll_components ADD CONSTRAINT payroll_components_rfi_earning_only
      CHECK (counts_as_rfi = FALSE OR component_type = 'earning') NOT VALID;
    ALTER TABLE payroll_components VALIDATE CONSTRAINT payroll_components_rfi_earning_only;
  END IF;
END $$;

ALTER TABLE payroll_employee_components ADD COLUMN IF NOT EXISTS percent_of_rfi NUMERIC(6,4);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_employee_components_percent_of_rfi') THEN
    ALTER TABLE payroll_employee_components ADD CONSTRAINT payroll_employee_components_percent_of_rfi
      CHECK (percent_of_rfi IS NULL OR (percent_of_rfi > 0 AND percent_of_rfi <= 1 AND amount = 0)) NOT VALID;
    ALTER TABLE payroll_employee_components VALIDATE CONSTRAINT payroll_employee_components_percent_of_rfi;
  END IF;
END $$;
