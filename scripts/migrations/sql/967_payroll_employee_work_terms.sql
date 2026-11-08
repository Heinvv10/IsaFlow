-- 967_payroll_employee_work_terms.sql
-- Wave 5 TS-a: the terms of work the payroll engine will read in later PRs (tax status, pay basis, hours, rates,
-- occupation). Nothing reads them yet, so no figure moves. tax_status is the one source of truth for "director"
-- (employment_type stays display and HR). No backfill: every existing row starts as employee / monthly through
-- the column defaults. payroll_employee_components gains quantity + quantity_unit for the hours/days per run (HD).
-- All new columns are nullable or defaulted, so no table rewrite beyond the constant defaults.
--
-- Rollback (code first): ALTER TABLE ... DROP COLUMN IF EXISTS for the nine columns below.

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
  ADD COLUMN IF NOT EXISTS quantity pg_catalog.numeric(8,2);
ALTER TABLE public.payroll_employee_components
  ADD COLUMN IF NOT EXISTS quantity_unit pg_catalog.text CHECK (quantity_unit IN ('hour', 'day'));
