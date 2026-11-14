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
--   payroll_employee_components.employer_fund_as_cash: see OPT-OUT BACKFILL at the end.
--
-- The new columns have constant defaults (no table rewrite); the CHECKs are added NOT VALID then validated, each
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

-- OPT-OUT BACKFILL (no figure change on deploy; as 970 did for 3810). Before this migration an earning coded 3817 / 3825 /
-- 3828 was paid and taxed as CASH (with a warning), never deemed into s11F. RF makes such an earning the employer's
-- non-cash contribution, deemed paid by the employee: an existing assignment would move net pay and PAYE. So every
-- assignment that EXISTS when this runs, of an earning coded 3817 / 3825 / 3828 (after the trim) of the employee's own
-- company, is marked employer_fund_as_cash = TRUE and keeps the cash treatment; the run warns on it
-- (EMPLOYER_FUND_KEPT_AS_CASH) and says how to switch: end it and assign the component again. Rows written after this
-- migration default to FALSE (the RF treatment). Deterministic; a re-run marks nothing new unless a fixed-amount row was
-- written since (migrations run once; named limit). A percent_of_rfi row cannot exist before this migration and is never marked.
ALTER TABLE payroll_employee_components ADD COLUMN IF NOT EXISTS employer_fund_as_cash BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE payroll_employee_components pec
   SET employer_fund_as_cash = TRUE
  FROM payroll_components pc, payroll_employees pe
 WHERE pc.id = pec.component_id
   AND pe.id = pec.employee_id
   AND pe.company_id = pc.company_id
   AND pc.component_type = 'earning'
   AND btrim(pc.sars_source_code, E' \t\r\n') IN ('3817', '3825', '3828')
   AND pec.percent_of_rfi IS NULL
   AND pec.employer_fund_as_cash = FALSE;
