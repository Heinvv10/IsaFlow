-- 1062: the bank account holder's relationship to the employee (master plan wave 7 EA2; Hein's ruling 26). Expand only.
--
-- WHAT.
--   payroll_bank_details.account_holder_relationship  'own' | 'joint' | 'third_party', NULL = not stated. e@syFile
--     writes it as code 3246, "Employee Account Holder Relationship", N1: "1. Own 2. Joint 3. Third Party", mandatory
--     when 3240 is not 0 or 7 (SARS BRS PAYE Employer Reconciliation V25.3.0, Jun-26, p. 46). Captured with the rest of
--     the bank details (payrollBankDetailsService); every row written before this release is NULL (not stated), and
--     the export names the employee instead of guessing.
--   The CHECK holds the three values; NOT VALID then VALIDATE (every existing row is NULL, so the scan passes).
--
-- GRANTS AND RLS unchanged: app_user's table-level INSERT (952) reaches the new column; its UPDATE stays is_active alone,
-- so a row's relationship, like the rest of it, is never rewritten (a change inserts the next row). No SECURITY DEFINER
-- writes the table: 888's change-history capture (a definer, unchanged, so no 930 registry row) records the whole row,
-- so the history gains the key; entityChangeMasking masks it with the other bank fields.
--
-- OLD COLOUR (the release before this one, running against this schema while the deploy switches colours):
--   insert  setEmployeeBankDetails names its columns; the new one is not among them, so a row it writes is NULL (the
--           CHECK passes NULL). A change made through the old colour therefore drops a stated relationship on the new
--           row (it was never shown there); the new colour's card shows "Not stated" and asks for it again. Accepted.
--   read    every reader names its columns (bank-details GET, duplicates, readiness, the bank file, the portal's
--           migration_admin read, payslips); none is the new one.
--
-- LOCKS. ADD COLUMN with no default is catalogue-only; ADD CONSTRAINT ... NOT VALID takes ACCESS EXCLUSIVE, held through
-- the VALIDATE (the runner applies the file in one transaction). payroll_bank_details is small (one row per employee per
-- change) and every row is NULL. Bounded by lock_timeout (5 s to get the lock) and statement_timeout.
--
-- Rollback (down SQL; roll the code back first, to a release that never reads or writes the column):
--   ALTER TABLE public.payroll_bank_details DROP CONSTRAINT IF EXISTS payroll_bank_details_account_holder_relationship_check;
--   ALTER TABLE public.payroll_bank_details DROP COLUMN IF EXISTS account_holder_relationship;
-- Change-history rows written since keep the key in before / after.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_bank_details ADD COLUMN IF NOT EXISTS account_holder_relationship TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conname = 'payroll_bank_details_account_holder_relationship_check'
                    AND conrelid = 'public.payroll_bank_details'::pg_catalog.regclass) THEN
    ALTER TABLE public.payroll_bank_details ADD CONSTRAINT payroll_bank_details_account_holder_relationship_check
      CHECK (account_holder_relationship IS NULL OR account_holder_relationship IN ('own', 'joint', 'third_party')) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.payroll_bank_details VALIDATE CONSTRAINT payroll_bank_details_account_holder_relationship_check;

COMMENT ON COLUMN public.payroll_bank_details.account_holder_relationship IS
  'Wave 7 EA2 (1062): e@syFile 3246 (BRS V25.3.0 p. 46): own = 1, joint = 2, third_party = 3; NULL = not stated.';
