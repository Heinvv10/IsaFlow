-- 999o: payslip email (wave 6 PE). Schema for emailing final payslips; nothing here sends anything.
--
-- WHAT.
--   payroll_employees.email  the address an employee's payslips go to (nullable; no row has one until a person
--     types it). A CHECK keeps it to one plain address: at most 254 characters, one '@', no spaces, commas,
--     semicolons, angle brackets or control characters, so a stored value can never name a second recipient or a
--     header. Added NOT VALID then validated (every existing row is NULL, so the validation is a scan that passes).
--   payroll_company_settings.payslip_email_enabled  created by 999a (off); app_user may now INSERT and UPDATE that
--     one column (999a and 999i granted only the pay-week and pay-day columns; 999i's trigger stamps updated_by /
--     updated_at). The send also needs the platform switch payroll_payslip_email (999a, off), checked first (rule 20).
--   payslip_deliveries  one row per payslip email attempted: the run, the employee, the run's approval it was for
--     (run_approved_at = the header's COALESCE(approved_at, approval_grandfathered_at) at send), the address, the
--     sha256 of the exact PDF bytes attached, the mail server's message id or the error, and whether it was a resend.
--     Append-only for app_user: INSERT and SELECT, no UPDATE, no DELETE. A BEFORE INSERT trigger (INVOKER, so under
--     the caller's RLS) refuses a row whose run is not a final run of the row's company at its current approval, or
--     whose employee has no line on that run: the table cannot hold a delivery the code would never write.
--
-- OLD COLOUR (the release before this one, running against this schema while the deploy switches colours):
--   insert  employee inserts name their columns; email is NULL and passes the CHECK. Nothing old writes the new
--           table or the new grant's column.
--   update  the employee PATCH names only the columns it changes; none is email. 999a's settings writes still hold.
--   read    SELECT pe.* (getPayrollEmployee) returns one extra column; mapEmployee ignores columns it does not name.
--
-- LOCKS. ADD COLUMN with no default is catalogue-only. ADD CONSTRAINT NOT VALID takes a brief ACCESS EXCLUSIVE;
-- VALIDATE takes SHARE UPDATE EXCLUSIVE (writes go on). Both bounded by lock_timeout, the file by statement_timeout.
--
-- Rollback (down SQL; roll the code back first, to a release that never reads these):
--   DROP TABLE IF EXISTS public.payslip_deliveries;
--   DROP FUNCTION IF EXISTS public.payslip_deliveries_guard();
--   REVOKE INSERT (payslip_email_enabled), UPDATE (payslip_email_enabled) ON public.payroll_company_settings FROM app_user;
--   ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_email_check;
--   ALTER TABLE public.payroll_employees DROP COLUMN IF EXISTS email;
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. The employee's payslip address ──────────────────────────────────────
ALTER TABLE public.payroll_employees ADD COLUMN IF NOT EXISTS email text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payroll_employees_email_check' AND conrelid = 'public.payroll_employees'::regclass) THEN
    ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_email_check
      CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@\s,;<>"()\[\]\\[:cntrl:]]+@[^@\s,;<>"()\[\]\\[:cntrl:]]+\.[^@\s,;<>"()\[\]\\[:cntrl:]]+$'))
      NOT VALID;
  END IF;
END $$;
ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT payroll_employees_email_check;

COMMENT ON COLUMN public.payroll_employees.email IS
  'Wave 6 PE (999o): where this employee''s payslips are emailed. NULL = none; the send skips and names the employee.';

-- ── 2. The company switch (999a made the column; app_user may now set it) ───
GRANT INSERT (payslip_email_enabled) ON public.payroll_company_settings TO app_user;
GRANT UPDATE (payslip_email_enabled) ON public.payroll_company_settings TO app_user;

-- ── 3. Deliveries ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payslip_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.payroll_run_headers(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.payroll_employees(id) ON DELETE CASCADE,
  run_approved_at TIMESTAMPTZ NOT NULL,
  recipient_email TEXT NOT NULL CHECK (char_length(recipient_email) <= 254),
  pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  message_id TEXT CHECK (char_length(message_id) <= 998),
  error TEXT CHECK (char_length(error) <= 500),
  resend BOOLEAN NOT NULL DEFAULT FALSE,
  sent_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'failed') = (error IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS payslip_deliveries_run_idx
  ON public.payslip_deliveries (company_id, run_id, employee_id, run_approved_at);

COMMENT ON TABLE public.payslip_deliveries IS
  'Wave 6 PE (999o): each payslip email attempted. pdf_sha256 is the hash of the exact bytes attached. Append-only.';

-- INVOKER: the lookups run under the caller's RLS, so another company's run or employee is simply not found.
CREATE OR REPLACE FUNCTION public.payslip_deliveries_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_run_headers h
      JOIN public.payroll_run_lines l ON l.run_id = h.id AND l.employee_id = NEW.employee_id
      JOIN public.payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
     WHERE h.id = NEW.run_id AND h.company_id = NEW.company_id
       AND h.status IN ('approved', 'paid')
       AND COALESCE(h.approved_at, h.approval_grandfathered_at) = NEW.run_approved_at
  ) THEN
    RAISE EXCEPTION 'payslip_deliveries: run % is not a final run of this company at that approval, or employee % has no line on it',
      NEW.run_id, NEW.employee_id USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payslip_deliveries_guard ON public.payslip_deliveries;
CREATE TRIGGER payslip_deliveries_guard BEFORE INSERT ON public.payslip_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.payslip_deliveries_guard();
ALTER TABLE public.payslip_deliveries ENABLE ALWAYS TRIGGER payslip_deliveries_guard;

ALTER TABLE public.payslip_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslip_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payslip_deliveries;
CREATE POLICY tenant_isolation ON public.payslip_deliveries FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON public.payslip_deliveries FROM app_user;
GRANT SELECT ON public.payslip_deliveries TO app_user;
GRANT INSERT (company_id, run_id, employee_id, run_approved_at, recipient_email, pdf_sha256, status, message_id, error, resend, sent_by)
  ON public.payslip_deliveries TO app_user;

SELECT public.app_service_sync_policies();
