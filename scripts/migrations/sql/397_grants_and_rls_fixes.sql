-- 397_grants_and_rls_fixes.sql
-- (1) Grant app_user access to practice_report_recipients (omitted from migration 387)
-- (2) Fix RLS policies on payroll_leave_* tables that used wrong GUC path

GRANT SELECT, INSERT, UPDATE, DELETE ON practice_report_recipients TO app_user;

-- Drop and recreate with correct GUC. Safe on both dbs: DROP IF EXISTS + policy check.
DROP POLICY IF EXISTS plt_company_iso ON payroll_leave_types;
DROP POLICY IF EXISTS plb_company_iso ON payroll_leave_balances;
DROP POLICY IF EXISTS plr_company_iso ON payroll_leave_requests;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'payroll_leave_types' AND relrowsecurity) THEN
    CREATE POLICY plt_company_iso ON payroll_leave_types
      USING (company_id = current_setting('app.current_company_id', true)::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'payroll_leave_balances' AND relrowsecurity) THEN
    CREATE POLICY plb_company_iso ON payroll_leave_balances
      USING (company_id = current_setting('app.current_company_id', true)::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'payroll_leave_requests' AND relrowsecurity) THEN
    CREATE POLICY plr_company_iso ON payroll_leave_requests
      USING (company_id = current_setting('app.current_company_id', true)::uuid);
  END IF;
END $$;
