-- 1056: an employee's residential and postal address on the employee record (master plan wave 7 EA1, W5 part 1;
-- Hein's ruling 10: the payroll admin captures it, the employee portal shows it read-only, no self-service edit).
-- Expand only.
--
-- WHAT. Fifteen nullable columns on payroll_employees, the fields an IRP5 / IT3(a) certificate carries for the
-- employee's addresses (SARS BRS PAYE Employer Reconciliation V25.3.0, Jun-26, pp. 34-40). Lengths are the BRS
-- length column; each CHECK names its code. The conditional rules (3214 mandatory, 3215 or 3216, a ZA postal code of
-- four digits not 0000, 3289 mandatory) are judged by payrollEmployeeAddressInput.ts before any write; the table
-- holds the lengths and the country-code shape, so no writer can store a value the certificate cannot carry.
--   Residential (pp. 34-35):
--     residential_unit_number     3211 AN8    residential_complex   3212 FT26   residential_street_number 3213 AN8
--     residential_street          3214 FT26   residential_suburb    3215 FT33   residential_city          3216 FT21
--     residential_postal_code     3217 AN10   residential_country_code 3285 A2
--   Postal (pp. 36-40). Two of the four structures of 3288 are captured: 1 (same as the residential address) and
--   4 (unstructured, four lines); a PO Box or a separate street address is written as the four lines. 3279 (care of)
--   is then N for both, which structure 4 requires (p. 36).
--     postal_same_as_residential  3288 = 1 when true, 4 when false
--     postal_address_line1..4     3289-3292 FT35
--     postal_address_code         3293 AN10   postal_address_country_code 3294 A2
--   The e@syFile writer (wave 7 EA2) writes these codes; until then UNWRITTEN_MANDATORY_CODES still lists them.
--
-- RLS and grants unchanged: payroll_employees' tenant_isolation and app_service policies cover the new columns, and
-- app_user's table-level SELECT / INSERT / UPDATE reaches them. 888's change-history capture records them (the
-- payroll_employee projection is the whole row); entityChangeMasking.ts masks them in the history.
--
-- OLD COLOUR (the release before this one, running against this schema while the deploy switches colours):
--   read    SELECT * returns the new keys; mapPayrollEmployeeRow picks its fields by name and ignores them, so no
--           old route serves them. Every other reader names its columns.
--   write   createPayrollEmployee and updatePayrollEmployee name their columns; none is new, so a row the old colour
--           inserts has NULLs (each CHECK passes NULL) and an update leaves the address as it is. The capture records
--           only keys whose value moved, so an old-colour update records no address key.
--
-- LOCKS. ADD COLUMN with no default is catalogue-only. ADD COLUMN and ADD CONSTRAINT ... NOT VALID take ACCESS EXCLUSIVE
-- on payroll_employees and the runner applies the file in ONE transaction, so that lock is held through the VALIDATEs.
-- Every new column is NULL on every row, and payroll_employees is small (one row per employee), so each scan is short.
-- Bounded by lock_timeout (5 s to get the lock) and statement_timeout.
--
-- Rollback (down SQL; roll the code back first, to a release that never reads or writes the columns):
--   ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_<column>_check;  -- each below
--   ALTER TABLE public.payroll_employees DROP COLUMN IF EXISTS <column>;                              -- each below
-- Change-history rows written since keep the address keys in before / after (masked when read).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS residential_unit_number TEXT NULL,
  ADD COLUMN IF NOT EXISTS residential_complex TEXT NULL,
  ADD COLUMN IF NOT EXISTS residential_street_number TEXT NULL,
  ADD COLUMN IF NOT EXISTS residential_street TEXT NULL,
  ADD COLUMN IF NOT EXISTS residential_suburb TEXT NULL,
  ADD COLUMN IF NOT EXISTS residential_city TEXT NULL,
  ADD COLUMN IF NOT EXISTS residential_postal_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS residential_country_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS postal_same_as_residential BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS postal_address_line1 TEXT NULL,
  ADD COLUMN IF NOT EXISTS postal_address_line2 TEXT NULL,
  ADD COLUMN IF NOT EXISTS postal_address_line3 TEXT NULL,
  ADD COLUMN IF NOT EXISTS postal_address_line4 TEXT NULL,
  ADD COLUMN IF NOT EXISTS postal_address_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS postal_address_country_code TEXT NULL;

-- One CHECK per column, named payroll_employees_<column>_check: (column, BRS code, its rule).
DO $$
DECLARE
  v_check pg_catalog.text[];
BEGIN
  FOREACH v_check SLICE 1 IN ARRAY ARRAY[
    ['residential_unit_number',     '3211 AN8',  'char_length(residential_unit_number) <= 8'],
    ['residential_complex',         '3212 FT26', 'char_length(residential_complex) <= 26'],
    ['residential_street_number',   '3213 AN8',  'char_length(residential_street_number) <= 8'],
    ['residential_street',          '3214 FT26', 'char_length(residential_street) <= 26'],
    ['residential_suburb',          '3215 FT33', 'char_length(residential_suburb) <= 33'],
    ['residential_city',            '3216 FT21', 'char_length(residential_city) <= 21'],
    ['residential_postal_code',     '3217 AN10', 'char_length(residential_postal_code) <= 10'],
    ['residential_country_code',    '3285 A2',   'residential_country_code ~ ''^[A-Z]{2}$'''],
    ['postal_address_line1',        '3289 FT35', 'char_length(postal_address_line1) <= 35'],
    ['postal_address_line2',        '3290 FT35', 'char_length(postal_address_line2) <= 35'],
    ['postal_address_line3',        '3291 FT35', 'char_length(postal_address_line3) <= 35'],
    ['postal_address_line4',        '3292 FT35', 'char_length(postal_address_line4) <= 35'],
    ['postal_address_code',         '3293 AN10', 'char_length(postal_address_code) <= 10'],
    ['postal_address_country_code', '3294 A2',   'postal_address_country_code ~ ''^[A-Z]{2}$''']
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conname = 'payroll_employees_' || v_check[1] || '_check'
                      AND conrelid = 'public.payroll_employees'::pg_catalog.regclass) THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.payroll_employees ADD CONSTRAINT %I CHECK (%I IS NULL OR (%s)) NOT VALID',
        'payroll_employees_' || v_check[1] || '_check', v_check[1], v_check[3]);
    END IF;
    EXECUTE pg_catalog.format('ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT %I', 'payroll_employees_' || v_check[1] || '_check');
    EXECUTE pg_catalog.format('COMMENT ON COLUMN public.payroll_employees.%I IS %L', v_check[1],
      'Wave 7 EA1 (1056): e@syFile code ' || v_check[2] || ' (SARS BRS PAYE Employer Reconciliation V25.3.0).');
  END LOOP;
END $$;

COMMENT ON COLUMN public.payroll_employees.postal_same_as_residential IS
  'Wave 7 EA1 (1056): e@syFile 3288, postal address structure: true = 1 (same as residential), false = 4 (unstructured lines).';
