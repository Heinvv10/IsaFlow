-- 1055: drop payroll_employees.tax_directive_number (wave 7 MH, W21). CONTRACT STEP.
--
-- The column has been dead since it was created in 380: nothing reads or writes it (the HYa census; 999b marked it
-- deprecated). Directives live in payroll_tax_directives. Its last name in code was the change-log masking list, removed
-- in the commit before this one. Queue this only after that release is LIVE: the previous colour then never names it.
--
-- OLD-COLOUR TEST. The previous release never selects it by name (it does SELECT * and maps known keys; the mapper
-- ignores a missing one) and never inserts into it, so it runs unchanged against the schema without it. The one place
-- that still listed it, entityChangeMasking, only masks keys a change-history snapshot contains: an absent key is
-- skipped.
--
-- pg_depend census: run before this, on the target database, expect no rows (a view, index or constraint on the column
-- would make the DROP fail or cascade; this migration does NOT use CASCADE, so a dependent object fails it loudly):
--   SELECT classid::regclass, objid, deptype FROM pg_depend d JOIN pg_attribute a
--     ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
--    WHERE d.refobjid = 'public.payroll_employees'::regclass AND a.attname = 'tax_directive_number'
--      AND d.classid <> 'pg_class'::regclass;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payroll_employees DROP COLUMN IF EXISTS tax_directive_number;
