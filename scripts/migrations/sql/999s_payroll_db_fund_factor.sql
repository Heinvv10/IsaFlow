-- 999s: Defined-benefit fund member category factor on an assignment (wave 6, PR DBF).
--
-- An employer's contribution to a DEFINED-BENEFIT pension or provident fund is a taxable fringe benefit valued not at the
-- contribution paid but per the Seventh Schedule para 12D(3): X = (A x B) - C (A the fund member category factor on the
-- fund's certificate, 12D(4); B the employee's retirement-funding income; C the employee's own contributions, excluding
-- additional voluntary contributions and buy-back: the Act's symbol definitions; the formula is an image in the Act, its
-- form read from the Sage Payroll Tax Pocket Guide 2025-2026 s7.12.2: UNVERIFIED). A defined-contribution-only category
-- is the contribution itself (12D(2)) and carries no factor. The run values X (definedBenefitFund.ts) and
-- treats it as the employer's non-cash 3817 / 3825 benefit deemed paid by the employee into s11F (G21 (2027) p. 10).
--
--   payroll_employee_components.db_member_category_factor: A, as a fraction (0.12 = 12%), more than 0 and at most 1.
--     Such a row stores amount 0 (the run decides the figure) and never also carries percent_of_rfi (975): one row is
--     either a defined-benefit value or a defined-contribution percentage. The service allows it only on a recurring
--     employer pension (3817) or provident (3825) contribution earning (definedBenefitFund.dbFactorRefusal).
--
-- Expand-only: a new nullable column (no default, no rewrite) and a CHECK added NOT VALID then validated (every row is
-- NULL here, so it validates at once), each only when absent, so a re-run is a no-op.
-- Old colour: the previous release never reads or writes the column. Its forward-compat guard (payrollRunKindGuard,
-- wave 6 FQa) refuses to calculate, approve or post a run whose assignments carry a factor, so a rollback never costs a
-- defined-benefit row as a plain R0 amount. Its INSERTs leave the column NULL, which the CHECK allows.

SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_employee_components ADD COLUMN IF NOT EXISTS db_member_category_factor NUMERIC(8,4);

COMMENT ON COLUMN payroll_employee_components.db_member_category_factor IS
  'DBF (999s): defined-benefit fund member category factor (fraction); the run values amount = max(0, factor x RFI - employee contributions), Seventh Schedule para 12D(3).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_employee_components_db_member_category_factor') THEN
    ALTER TABLE payroll_employee_components ADD CONSTRAINT payroll_employee_components_db_member_category_factor
      CHECK (db_member_category_factor IS NULL OR (
        db_member_category_factor > 0 AND db_member_category_factor <= 1 AND amount = 0 AND percent_of_rfi IS NULL
      )) NOT VALID;
    ALTER TABLE payroll_employee_components VALIDATE CONSTRAINT payroll_employee_components_db_member_category_factor;
  END IF;
END $$;
