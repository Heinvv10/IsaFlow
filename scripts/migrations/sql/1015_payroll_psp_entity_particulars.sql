-- 1015: a personal service provider's entity particulars (wave 6 PSP-H), for its H certificate.
--
-- WHAT.
--   payroll_employees.psp_entity_name          the trading name of the company / CC or trust: e@syFile 3030 for nature of
--                                              person H (SARS PAYE Employer Reconciliation BRS V25.3.0 p. 20: "If Nature of
--                                              Person is D / E / F / G / H the trading name of the trust / company").
--   payroll_employees.psp_registration_number  its registration number: 3066, with 3065 = 1 (company / CC registration
--                                              number) or 2 (trust registration number) for H (BRS V25.3.0 p. 23, "May be
--                                              completed if Nature of Person is D / E / G / H"). Free text, at most 30 (FT30).
--   payroll_employees.psp_tax_reference        the entity's income tax reference: 3100, ten digits starting with 9 for E, G
--                                              and H (BRS V25.3.0 p. 26-27), mandatory when PAYE (4102) is above nil.
--   Each is nullable with no default: every existing row is NULL. A non-PSP row holds none of them
--   (payroll_employees_psp_particulars_only_psp); a PSP may hold none yet (its months are then on no certificate, named,
--   as before PSP-H).
--
-- OLD COLOUR (the release before this one, #1566, running against this schema while the deploy switches colours):
--   insert  createPayrollEmployee names none of the new columns: all NULL, every CHECK holds.
--   update  it never writes them. One case is refused: it moving a PSP that HAS particulars off PSP (to employee) leaves
--           them set, and payroll_employees_psp_particulars_only_psp refuses the update (23514, an error, no row changed).
--           Fail closed: nothing is costed on a half-changed row. A PSP with no particulars moves freely, as today.
--   read    SELECT * returns the extra columns; mapPayrollEmployeeRow ignores columns it does not name. The old colour's
--           e@syFile leaves every PSP line off the certificates with a named warning, as it does today.
--
-- LOCKS. ADD COLUMN with no default is catalogue-only. ADD CONSTRAINT takes ACCESS EXCLUSIVE on payroll_employees for the
-- transaction; NOT VALID skips the scan there, and VALIDATE (SHARE UPDATE EXCLUSIVE) scans a small table. Acquiring the lock
-- is bounded by lock_timeout, the whole by statement_timeout.
--
-- Rollback (down SQL; roll the code back first):
--   ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_particulars_only_psp;
--   ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_tax_reference_shape;
--   ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_text_lengths;
--   ALTER TABLE public.payroll_employees DROP COLUMN IF EXISTS psp_tax_reference;
--   ALTER TABLE public.payroll_employees DROP COLUMN IF EXISTS psp_registration_number;
--   ALTER TABLE public.payroll_employees DROP COLUMN IF EXISTS psp_entity_name;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_employees ADD COLUMN IF NOT EXISTS psp_entity_name pg_catalog.text;
ALTER TABLE public.payroll_employees ADD COLUMN IF NOT EXISTS psp_registration_number pg_catalog.text;
ALTER TABLE public.payroll_employees ADD COLUMN IF NOT EXISTS psp_tax_reference pg_catalog.text;

-- Only a PSP holds entity particulars.
ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_particulars_only_psp;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_psp_particulars_only_psp
  CHECK (tax_status = 'personal_service_provider'
         OR (psp_entity_name IS NULL AND psp_registration_number IS NULL AND psp_tax_reference IS NULL)) NOT VALID;

-- 3100 for H: ten digits starting with 9 (BRS V25.3.0 p. 26-27).
ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_tax_reference_shape;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_psp_tax_reference_shape
  CHECK (psp_tax_reference IS NULL OR psp_tax_reference ~ '^9[0-9]{9}$') NOT VALID;

-- 3030 is FT120, 3066 FT30 (BRS V25.3.0 pp. 20, 24); never blank when set.
ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_psp_text_lengths;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_psp_text_lengths
  CHECK ((psp_entity_name IS NULL OR char_length(btrim(psp_entity_name)) BETWEEN 1 AND 120)
     AND (psp_registration_number IS NULL OR char_length(btrim(psp_registration_number)) BETWEEN 1 AND 30)) NOT VALID;

ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT payroll_employees_psp_particulars_only_psp;
ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT payroll_employees_psp_tax_reference_shape;
ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT payroll_employees_psp_text_lengths;
