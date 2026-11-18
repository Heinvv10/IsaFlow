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
--   payroll_employee_components.db_member_category_factor: A, as a fraction (0.12 = 12%), more than 0 and at most 1. Its
--     `amount` is what the employer actually pays the fund (GL 2175 / labour, IRP5 4472 / 4473; BRS V25.3.0 p. 103), not
--     X; 0 only when the employer pays nothing. Never with percent_of_rfi (975). The service allows a factor only on a
--     recurring employer pension (3817) or provident (3825) contribution earning (definedBenefitFund.dbFactorRefusal).
--   payroll_employee_components.db_member_retired: the member has retired from the fund, or is a dependant or nominee of
--     a deceased member: para 12D(6), no value; the contribution is reported as 4585 / 4586 (BRS p. 105-106). Only on a
--     factor row.
--   payroll_employee_components.db_fund_member_contribution: on the employee's 4001 / 4003 deduction, marks it as the
--     compulsory contribution to the defined-benefit fund: C is the marked rows only (12D(3) excludes voluntary
--     contributions and buy-back; another fund's contribution is not C).
--   payroll_components.fund_type: 'defined_contribution' or 'defined_benefit', as chosen when a 3817 / 3825 / 3828
--     component is created (NULL for older components and every other code). A defined_benefit component's assignment
--     needs a factor on every write path (payrollAssignmentWriteGuard).
--
-- Expand-only: new columns (nullable, or boolean NOT NULL DEFAULT false: a constant default, no rewrite) and CHECKs added
-- NOT VALID then validated (every row is NULL / false here, so they validate at once), each only when absent: a re-run is
-- a no-op.
-- Old colour: the previous release never reads or writes these columns. Its forward-compat guard (payrollRunKindGuard,
-- wave 6 FQa) refuses to calculate, approve or post a run whose assignments carry a factor, so a rollback never costs a
-- defined-benefit row as a plain amount. Its INSERTs leave the columns NULL / false, which the CHECKs allow; it can still
-- assign a defined_benefit component without a factor, which this release's guard refuses (a rollback-only gap).

SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_employee_components ADD COLUMN IF NOT EXISTS db_member_category_factor NUMERIC(8,4);
ALTER TABLE payroll_employee_components ADD COLUMN IF NOT EXISTS db_member_retired BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payroll_employee_components ADD COLUMN IF NOT EXISTS db_fund_member_contribution BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payroll_components ADD COLUMN IF NOT EXISTS fund_type TEXT;

COMMENT ON COLUMN payroll_employee_components.db_member_category_factor IS
  'DBF (999s): defined-benefit fund member category factor (fraction); the run values the fringe X = max(0, factor x RFI - C), Seventh Schedule para 12D(3); amount is the contribution the employer pays.';
COMMENT ON COLUMN payroll_employee_components.db_member_retired IS
  'DBF (999s): para 12D(6) member (retired, or a deceased member''s dependant or nominee): no value; reported as 4585 / 4586.';
COMMENT ON COLUMN payroll_employee_components.db_fund_member_contribution IS
  'DBF (999s): this 4001 / 4003 deduction is the compulsory contribution to the defined-benefit fund (C in para 12D(3)).';
COMMENT ON COLUMN payroll_components.fund_type IS
  'DBF (999s): defined_contribution or defined_benefit for an employer fund contribution (3817 / 3825 / 3828); NULL otherwise or before 999s.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_employee_components_db_member_category_factor') THEN
    ALTER TABLE payroll_employee_components ADD CONSTRAINT payroll_employee_components_db_member_category_factor
      CHECK (db_member_category_factor IS NULL OR (
        db_member_category_factor > 0 AND db_member_category_factor <= 1 AND amount >= 0 AND percent_of_rfi IS NULL
      )) NOT VALID;
    ALTER TABLE payroll_employee_components VALIDATE CONSTRAINT payroll_employee_components_db_member_category_factor;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_employee_components_db_member_retired') THEN
    ALTER TABLE payroll_employee_components ADD CONSTRAINT payroll_employee_components_db_member_retired
      CHECK (NOT db_member_retired OR db_member_category_factor IS NOT NULL) NOT VALID;
    ALTER TABLE payroll_employee_components VALIDATE CONSTRAINT payroll_employee_components_db_member_retired;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_employee_components_db_fund_member_contribution') THEN
    ALTER TABLE payroll_employee_components ADD CONSTRAINT payroll_employee_components_db_fund_member_contribution
      CHECK (NOT db_fund_member_contribution OR db_member_category_factor IS NULL) NOT VALID;
    ALTER TABLE payroll_employee_components VALIDATE CONSTRAINT payroll_employee_components_db_fund_member_contribution;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_components_fund_type') THEN
    ALTER TABLE payroll_components ADD CONSTRAINT payroll_components_fund_type
      CHECK (fund_type IS NULL OR fund_type IN ('defined_contribution', 'defined_benefit')) NOT VALID;
    ALTER TABLE payroll_components VALIDATE CONSTRAINT payroll_components_fund_type;
  END IF;
END $$;
