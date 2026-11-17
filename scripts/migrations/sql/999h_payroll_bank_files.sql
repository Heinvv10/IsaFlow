-- 999h: salary bank files (wave 6 BF). A record of each ACB salary file generated for a pay run.
--
-- WHAT.
--   payroll_bank_files  one row per file generated for a final pay run: the layout it was written to, the sha256 of
--     the exact bytes served, the transaction count, the total in cents, the action date, and the run approval it
--     pays (run_approved_at = the header's COALESCE(approved_at, approval_grandfathered_at) when generated; a reopen
--     ends that approval, so the file is then stale and cannot be confirmed).
--     status  generated -> confirmed (the user records that the bank accepted it) | voided (a person attests it was
--             never sent: void_not_sent). Confirmed and voided are final. Confirm records the bank's acceptance only: nothing here, or in BF's code, writes the
--             run header, which stays 'approved' and reopenable (Hein's ruling P1, spec 0a.17).
--   payroll_bank_files_one_live_per_run  at most one generated or confirmed file per run.
--   payroll_bank_files_guard  a BEFORE trigger (INVOKER, so under the caller's RLS; ENABLE ALWAYS):
--     insert  the run is this company's, its status is 'approved', and run_approved_at is its current approval
--             (COALESCE(approved_at, approval_grandfathered_at)): no file for an unapproved or paid run;
--     update  only generated -> confirmed or generated -> voided, never a change to the file's facts. Confirm needs
--             the file's approval to be the run's current one or one in its approval_history (a reopened run's file
--             the bank did pay must still be recordable); void needs void_not_sent.
--     stamps  created_by / confirmed_by / voided_by are the session user (auth.uid(), as 999c), never what the caller
--             wrote; no session user is refused. Times are the trigger's clock. The column grants stop the rest.
--   feature_flags  payroll_salary_bank_file, OFF (rule 20). 999a creates it too; ON CONFLICT DO NOTHING here.
--
-- OLD COLOUR: a new table that the previous release never reads or writes. Its reopen does not read it (the new
--   release only warns from it), and a reopen by old code still makes a generated file stale, because staleness is
--   judged from the header's approval time, not from a write at reopen.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TABLE IF EXISTS public.payroll_bank_files;
--   DROP FUNCTION IF EXISTS public.payroll_bank_files_guard();
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.payroll_bank_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id),
  run_id UUID NOT NULL REFERENCES public.payroll_run_headers(id),
  format TEXT NOT NULL DEFAULT 'acb' CHECK (format = 'acb'),
  layout TEXT NOT NULL CHECK (layout IN ('fnb_obe_2023_02')),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  line_count INTEGER NOT NULL CHECK (line_count > 0),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  action_date DATE NOT NULL,
  run_approved_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'confirmed', 'voided')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  voided_by TEXT,
  voided_at TIMESTAMPTZ,
  void_not_sent BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT payroll_bank_files_confirmed_stamps CHECK ((status = 'confirmed') = (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CONSTRAINT payroll_bank_files_voided_stamps CHECK ((status = 'voided') = (voided_by IS NOT NULL AND voided_at IS NOT NULL)),
  CONSTRAINT payroll_bank_files_void_attested CHECK (status <> 'voided' OR void_not_sent)
);

COMMENT ON TABLE public.payroll_bank_files IS
  'Salary bank (ACB) files generated for a pay run (999h, wave 6 BF). confirmed = the bank accepted it; the run header is never written from here.';

CREATE UNIQUE INDEX IF NOT EXISTS payroll_bank_files_one_live_per_run
  ON public.payroll_bank_files (run_id) WHERE status IN ('generated', 'confirmed');
CREATE INDEX IF NOT EXISTS payroll_bank_files_company_run ON public.payroll_bank_files (company_id, run_id);

CREATE OR REPLACE FUNCTION public.payroll_bank_files_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid text := auth.uid();
  h record;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'payroll_bank_files: a bank-file write needs a session user' USING ERRCODE = '42501';
  END IF;
  SELECT status, COALESCE(approved_at, approval_grandfathered_at) AS final_at, approval_history
    INTO h FROM public.payroll_run_headers WHERE id = NEW.run_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_bank_files: the run is not this company''s' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'generated' OR h.status <> 'approved' OR h.final_at IS NULL OR NEW.run_approved_at IS DISTINCT FROM h.final_at THEN
      RAISE EXCEPTION 'payroll_bank_files: a file is recorded as generated, for an approved run, at its current approval'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_by := uid;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'generated' OR NEW.status NOT IN ('confirmed', 'voided')
     OR (NEW.company_id, NEW.run_id, NEW.format, NEW.layout, NEW.sha256, NEW.line_count, NEW.total_cents,
         NEW.action_date, NEW.run_approved_at, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.company_id, OLD.run_id, OLD.format, OLD.layout, OLD.sha256, OLD.line_count, OLD.total_cents,
         OLD.action_date, OLD.run_approved_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'payroll_bank_files: only a generated file may be confirmed or voided, and its facts never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'confirmed' THEN
    IF NOT (NEW.run_approved_at = h.final_at OR COALESCE(h.approval_history @> NEW.run_approved_at, false)) THEN
      RAISE EXCEPTION 'payroll_bank_files: the file pays an approval this run never had' USING ERRCODE = 'check_violation';
    END IF;
    NEW.confirmed_by := uid;
    NEW.confirmed_at := clock_timestamp();
  ELSE
    IF NOT NEW.void_not_sent THEN
      RAISE EXCEPTION 'payroll_bank_files: a void must attest the file was not sent to the bank' USING ERRCODE = 'check_violation';
    END IF;
    NEW.voided_by := uid;
    NEW.voided_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_bank_files_guard ON public.payroll_bank_files;
CREATE TRIGGER payroll_bank_files_guard BEFORE INSERT OR UPDATE ON public.payroll_bank_files
  FOR EACH ROW EXECUTE FUNCTION public.payroll_bank_files_guard();
ALTER TABLE public.payroll_bank_files ENABLE ALWAYS TRIGGER payroll_bank_files_guard;

ALTER TABLE public.payroll_bank_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_bank_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payroll_bank_files;
CREATE POLICY tenant_isolation ON public.payroll_bank_files FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON public.payroll_bank_files FROM app_user;
GRANT SELECT ON public.payroll_bank_files TO app_user;
GRANT INSERT (company_id, run_id, format, layout, sha256, line_count, total_cents, action_date, run_approved_at, created_by)
  ON public.payroll_bank_files TO app_user;
GRANT UPDATE (status, confirmed_by, confirmed_at, voided_by, voided_at, void_not_sent) ON public.payroll_bank_files TO app_user;

INSERT INTO public.feature_flags (code, name, description, is_global) VALUES
  ('payroll_salary_bank_file', 'Payroll: salary bank file',
   'Generating the salary bank (ACB) file. Platform switch; off until a bank has accepted a test import.', false)
ON CONFLICT (code) DO NOTHING;

SELECT public.app_service_sync_policies();
