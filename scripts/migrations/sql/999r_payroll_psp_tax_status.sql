-- 999r: personal service providers (wave 6 PSP).
--
-- WHAT.
--   payroll_employees.tax_status  CHECK widened to a superset: 'personal_service_provider' joins 'employee', 'director'
--     and 'independent_contractor' (Fourth Schedule para 1 "employee" (d) and "personal service provider"; SARS
--     PAYE-GEN-01-G21 (2027) Rev 1 p. 31). Dropped and re-added under its own name, NOT VALID, then VALIDATEd.
--   payroll_employees.psp_entity_type  'company' (a company, including a close corporation) or 'trust': it picks the
--     rate (SARS PAYE-GEN-01-G01-A06 row 6: 27% for a company, 45% for a trust; taxTables.ts). Set exactly when the
--     tax status is personal_service_provider (payroll_employees_psp_entity_pair). Nullable, no default: every
--     existing row is NULL and none is a PSP, so both new CHECKs hold on every row before they are validated.
--
-- OLD COLOUR (the release before this one, running against this schema while the deploy switches colours):
--   insert  createPayrollEmployee names neither the new value nor the new column: psp_entity_type is NULL and the
--           status one of the old three, so the widened CHECK, the entity CHECK and the pair CHECK all hold.
--   update  it writes tax_status only to one of the old three and never touches psp_entity_type. One case is
--           refused: it moving a PSP (only this release writes one) back to employee leaves psp_entity_type set,
--           and the pair CHECK refuses the update (23514, answered as an error, no row changed). That is the fail
--           closed direction: nothing is costed on a half-changed row.
--   read    SELECT * returns the extra column; mapPayrollEmployeeRow ignores columns it does not name. A PSP row it does
--           meet (only after a rollback past this release) it cannot map: termsFromRow throws "Stored tax_status must be
--           one of ...", so every read that maps that company's employees (the employee list, the profile, a run's
--           calculation) answers a generic 500, not a named refusal. That is fail-closed (nothing is costed or filed for
--           anyone in that company until the code rolls forward or the row is moved off PSP), not a graceful one.
--           payrollRunKindGuard's unknown-status clause (999a, FQa) would name the employee, but the mapping throws first.
--
-- LOCKS. ADD COLUMN with no default is catalogue-only. DROP/ADD CONSTRAINT take ACCESS EXCLUSIVE on payroll_employees
-- for the length of this transaction; NOT VALID skips the scan there, and VALIDATE (SHARE UPDATE EXCLUSIVE) scans a
-- small table (hundreds of rows). Acquiring the lock is bounded by lock_timeout, the whole by statement_timeout.
--
-- Rollback (down SQL; roll the code back first, and move any PSP row back to another status before this):
--   ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_entity_pair;
--   ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_entity_type_check;
--   ALTER TABLE public.payroll_employees DROP COLUMN IF EXISTS psp_entity_type;
--   ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_tax_status_check;
--   ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_tax_status_check
--     CHECK (tax_status IN ('employee', 'director', 'independent_contractor'));

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_employees ADD COLUMN IF NOT EXISTS psp_entity_type pg_catalog.text;

-- The superset: every value the old CHECK allowed, plus personal_service_provider.
ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_tax_status_check;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_tax_status_check
  CHECK (tax_status IN ('employee', 'director', 'independent_contractor', 'personal_service_provider')) NOT VALID;

ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_entity_type_check;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_psp_entity_type_check
  CHECK (psp_entity_type IS NULL OR psp_entity_type IN ('company', 'trust')) NOT VALID;

-- A PSP has an entity type, and nobody else has one.
ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_entity_pair;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_psp_entity_pair
  CHECK ((tax_status = 'personal_service_provider') = (psp_entity_type IS NOT NULL)) NOT VALID;

ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT payroll_employees_tax_status_check;
ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT payroll_employees_psp_entity_type_check;
ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT payroll_employees_psp_entity_pair;
