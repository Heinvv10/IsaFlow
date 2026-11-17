-- 999t_payroll_run_input_units.sql
-- Wave 6 RI: overtime hours at a multiplier and reimbursive travel km, both recorded on a pay run's once-off component row.
--   - quantity_unit widens from ('hour','day') to ('hour','day','km'): a superset, so every existing row still holds.
--   - rate_multiplier NUMERIC(4,2) NULL, 1.5 or 2.0 only (BCEA 75 of 1997 s10(2) overtime 1.5x; s16(1) Sunday and
--     s18(2)(b)(i) public holiday 2x), and only on an hours row.
-- Expand-only (spec rule 13): a widened CHECK and a new nullable column. Each new CHECK is added NOT VALID, then
-- VALIDATEd (no row can fail it: every existing rate_multiplier is NULL and every unit is hour or day).
--
-- Old-colour test: the previous release never writes 'km' or rate_multiplier, so its inserts and updates pass both
-- CHECKs unchanged. Reading a row this release wrote, its forward-compat guard (payrollRunKindGuard, FQa) refuses to
-- calculate, approve or post a run with a km row or a multiplier (read through to_jsonb, never by name), so it never
-- costs one as ordinary pay.
--
-- Rollback (code first): DELETE (or end) the km and multiplier rows, then
--   ALTER TABLE payroll_employee_components DROP CONSTRAINT payroll_employee_components_rate_multiplier_hours;
--   ALTER TABLE payroll_employee_components DROP COLUMN rate_multiplier;
--   and re-add payroll_employee_components_quantity_unit_check as CHECK (quantity_unit IN ('hour','day')).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 967's unnamed inline CHECK is payroll_employee_components_quantity_unit_check (Postgres' own naming).
ALTER TABLE public.payroll_employee_components DROP CONSTRAINT IF EXISTS payroll_employee_components_quantity_unit_check;
ALTER TABLE public.payroll_employee_components ADD CONSTRAINT payroll_employee_components_quantity_unit_check
  CHECK (quantity_unit IN ('hour', 'day', 'km')) NOT VALID;
ALTER TABLE public.payroll_employee_components VALIDATE CONSTRAINT payroll_employee_components_quantity_unit_check;

ALTER TABLE public.payroll_employee_components
  ADD COLUMN IF NOT EXISTS rate_multiplier pg_catalog.numeric(4,2);

ALTER TABLE public.payroll_employee_components DROP CONSTRAINT IF EXISTS payroll_employee_components_rate_multiplier_hours;
ALTER TABLE public.payroll_employee_components ADD CONSTRAINT payroll_employee_components_rate_multiplier_hours
  CHECK (rate_multiplier IS NULL OR (rate_multiplier IN (1.5, 2.0) AND quantity_unit = 'hour')) NOT VALID;
ALTER TABLE public.payroll_employee_components VALIDATE CONSTRAINT payroll_employee_components_rate_multiplier_hours;

COMMENT ON COLUMN public.payroll_employee_components.rate_multiplier IS
  'Wave 6 RI: overtime multiplier on an hours row (1.5 BCEA s10(2); 2.0 BCEA s16(1)/s18(2)). amount = quantity x hourly rate x multiplier.';
