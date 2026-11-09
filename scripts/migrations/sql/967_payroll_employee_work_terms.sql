-- 967_payroll_employee_work_terms.sql
-- Wave 5 TS-a: the terms of work the payroll engine will read in later PRs (tax status, pay basis, hours, rates,
-- occupation). Nothing reads them yet, so no figure moves. tax_status is the one source of truth for "director"
-- (employment_type stays display and HR); the one backfill makes it agree with the stored type: a row whose
-- employment_type is 'director' becomes tax_status 'director', every other row stays employee / monthly through the
-- column defaults. Cross-column CHECKs: an hourly or daily employee carries its rate, a day is not longer than the
-- week (a monthly employee may carry hours: TS-b and ET read them). payroll_employee_components gains quantity +
-- quantity_unit for the hours/days per run (HD), both or neither, quantity above 0.
-- All new columns are nullable or defaulted, so no table rewrite beyond the constant defaults.
--
-- Rollback (code first): DROP the three payroll_employees_* constraints and payroll_employee_components_quantity_pair,
-- then ALTER TABLE ... DROP COLUMN IF EXISTS for the nine columns below. The backfill is not undone (nothing read it).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS tax_status pg_catalog.text NOT NULL DEFAULT 'employee'
    CHECK (tax_status IN ('employee', 'director', 'independent_contractor'));
ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS pay_basis pg_catalog.text NOT NULL DEFAULT 'monthly'
    CHECK (pay_basis IN ('monthly', 'hourly', 'daily'));
ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS hours_per_week pg_catalog.numeric(5,2)
    CHECK (hours_per_week > 0 AND hours_per_week <= 168);
ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS hours_per_day pg_catalog.numeric(4,2)
    CHECK (hours_per_day > 0 AND hours_per_day <= 24);
ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS hourly_rate pg_catalog.numeric(12,2) CHECK (hourly_rate >= 0);
ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS daily_rate pg_catalog.numeric(12,2) CHECK (daily_rate >= 0);
ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS occupation pg_catalog.text CHECK (pg_catalog.char_length(occupation) <= 100);

ALTER TABLE public.payroll_employee_components
  ADD COLUMN IF NOT EXISTS quantity pg_catalog.numeric(8,2) CHECK (quantity > 0);
ALTER TABLE public.payroll_employee_components
  ADD COLUMN IF NOT EXISTS quantity_unit pg_catalog.text CHECK (quantity_unit IN ('hour', 'day'));

-- Drop-then-add keeps a re-run idempotent (ADD CONSTRAINT has no IF NOT EXISTS). The CHECKs hold for every existing
-- row: all are monthly with no hours or rates, and no component carries a quantity.
ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_hourly_rate_required;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_hourly_rate_required
  CHECK (pay_basis <> 'hourly' OR (hourly_rate IS NOT NULL AND hourly_rate > 0));
ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_daily_rate_required;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_daily_rate_required
  CHECK (pay_basis <> 'daily' OR (daily_rate IS NOT NULL AND daily_rate > 0));
ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_day_within_week;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_day_within_week
  CHECK (hours_per_day IS NULL OR hours_per_week IS NULL OR hours_per_day <= hours_per_week);
ALTER TABLE public.payroll_employee_components DROP CONSTRAINT IF EXISTS payroll_employee_components_quantity_pair;
ALTER TABLE public.payroll_employee_components ADD CONSTRAINT payroll_employee_components_quantity_pair
  CHECK ((quantity IS NULL) = (quantity_unit IS NULL));

-- Deterministic backfill: the stored employment type decides, once. A row already moved off the default is left.
UPDATE public.payroll_employees SET tax_status = 'director'
 WHERE employment_type = 'director' AND tax_status = 'employee';
