-- The Demo company and the E2E admin of a hosted Golden Paths run, on the
-- throwaway database up.sh builds (schema only: no row of velo's isaflow_dev,
-- which holds the real Demo, is read or copied).
--
--   psql -v admin_id=<GoTrue user id> -v admin_email=<email> -f seed-demo.sql
--
-- What it makes: the company through create_company_with_owner (the function
-- the app's own "new company" call uses: company row, owner membership,
-- chart of accounts with the system-account mappings, AFS lines), flagged
-- is_demo and VAT-registered; the admin's profile row; and the financial
-- years the suite posts into. Transactions come later, through the app
-- (seed-demo-app.ts), so every posting path runs.
\set ON_ERROR_STOP on

-- auth.uid() inside create_company_with_owner reads the JWT claims setting.
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin_id')::text, false) \gset

INSERT INTO users (id, email, first_name, last_name, role, is_active, onboarding_completed)
VALUES (:'admin_id', :'admin_email', 'Golden', 'Admin', 'admin', true, true);

SELECT id AS company_id FROM create_company_with_owner(jsonb_build_object(
  'name', 'IsaDemo (Golden Paths CI)',
  'tradingName', 'IsaDemo',
  'registrationNumber', '2026/000001/07',
  'vatNumber', '4000000001',
  'email', 'demo@isaflow.test',
  'phone', '0110000000',
  'addressLine1', '1 Demo Street',
  'city', 'Johannesburg',
  'province', 'Gauteng',
  'postalCode', '2000',
  'financialYearStart', 3,
  'vatPeriod', 'bi-monthly'
)) \gset

UPDATE companies SET is_demo = true, status = 'active', is_active = true WHERE id = :'company_id';

-- Financial years: the one holding the run's date, and those the suite posts
-- into (2026-01 .. 2027-02: the payroll sandbox month is 2027-02).
SELECT fiscal_periods_generate(fiscal_year_ensure(:'company_id'::uuid, d::date))
FROM unnest(ARRAY['2025-06-01', '2026-06-01', '2027-01-15', current_date::text]) AS d;
