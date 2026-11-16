-- 999h: salary bank files (wave 6 BF). A record of each ACB salary file generated for a pay run.
--
-- WHAT.
--   payroll_bank_files  one row per file generated for a final pay run: the layout it was written to, the sha256 of
--     the exact bytes served, the transaction count, the total in cents, the action date, and the run approval it
--     pays (run_approved_at = the header's COALESCE(approved_at, approval_grandfathered_at) when generated; a reopen
--     ends that approval, so the file is then stale and cannot be confirmed).
--     status  generated -> confirmed (the user records that the bank accepted it) | voided (never sent). Confirmed and
--             voided are final. Confirm records the bank's acceptance only: nothing here, or in BF's code, writes the
--             run header, which stays 'approved' and reopenable (Hein's ruling P1, spec 0a.17).
--   payroll_bank_files_one_live_per_run  at most one generated or confirmed file per run.
--   payroll_bank_files_guard  a BEFORE trigger (INVOKER, so under the caller's RLS): an insert must name a run of the
--     same company; an update may only move generated -> confirmed or generated -> voided, never touch the file's
--     facts, and stamps the transition time itself. The column grants already stop app_user writing anything else.
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
  CONSTRAINT payroll_bank_files_confirmed_stamps CHECK ((status = 'confirmed') = (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CONSTRAINT payroll_bank_files_voided_stamps CHECK ((status = 'voided') = (voided_by IS NOT NULL AND voided_at IS NOT NULL))
);

COMMENT ON TABLE public.payroll_bank_files IS
  'Salary bank (ACB) files generated for a pay run (999h, wave 6 BF). confirmed = the bank accepted it; the run header is never written from here.';

CREATE UNIQUE INDEX IF NOT EXISTS payroll_bank_files_one_live_per_run
  ON public.payroll_bank_files (run_id) WHERE status IN ('generated', 'confirmed');
CREATE INDEX IF NOT EXISTS payroll_bank_files_company_run ON public.payroll_bank_files (company_id, run_id);

CREATE OR REPLACE FUNCTION public.payroll_bank_files_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'generated' THEN
      RAISE EXCEPTION 'payroll_bank_files: a file is recorded as generated' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.payroll_run_headers h WHERE h.id = NEW.run_id AND h.company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'payroll_bank_files: the run is not this company''s' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.created_at := now();
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
  IF NEW.status = 'confirmed' THEN NEW.confirmed_at := now(); ELSE NEW.voided_at := now(); END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_bank_files_guard ON public.payroll_bank_files;
CREATE TRIGGER payroll_bank_files_guard BEFORE INSERT OR UPDATE ON public.payroll_bank_files
  FOR EACH ROW EXECUTE FUNCTION public.payroll_bank_files_guard();

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
GRANT UPDATE (status, confirmed_by, confirmed_at, voided_by, voided_at) ON public.payroll_bank_files TO app_user;

INSERT INTO public.feature_flags (code, name, description, is_global) VALUES
  ('payroll_salary_bank_file', 'Payroll: salary bank file',
   'Generating the salary bank (ACB) file. Platform switch; off until a bank has accepted a test import.', false)
ON CONFLICT (code) DO NOTHING;

SELECT public.app_service_sync_policies();
