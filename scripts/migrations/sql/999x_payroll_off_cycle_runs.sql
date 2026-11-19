-- 999x: off-cycle bonus and termination runs (wave 6 OC). Expand-only.
--
-- WHAT.
--   payroll_off_cycle_employees  who an off-cycle run pays, written when the run is created; only a bonus row's amount
--     changes after that (review #1620 final breaker M: correcting an amount keyed in error, on a draft or calculated
--     bonus run, including one reopened before its month's EMP201 is filed):
--     bonus        one row per employee, with the annual-payment earning (a 3605 component of the company) and the
--                  amount; the line pays that alone (no salary, recurring component, loan or deduction);
--     termination  one row per employee, with neither: the line pays the leaver's termination pay-outs.
--     Off-cycle inputs live here and NOT as once-off payroll_employee_components: the run reader pays a once-off
--     dated in its month whatever its end (payrollComponentService), so a bonus written there would be paid again by
--     the month's regular run when that run is reopened and recalculated.
--     payroll_off_cycle_employees_guard  a BEFORE INSERT trigger (INVOKER, under the caller's RLS): the run is this
--     company's, an off-cycle run, still a draft; the employee is this company's; a bonus row names one of this
--     company's 3605 earnings and a termination row names none. On UPDATE (app_user may update the amount column
--     only): the run is this company's DRAFT bonus run (the service sends a calculated run back to draft and clears its
--     lines first); company, run, employee and earning stay as they were; the amount is more than R0 in whole cents.
--     app_user may INSERT, SELECT and UPDATE (amount).
--   payroll_run_headers.off_cycle_paid_gross  each employee's gross on an off-cycle run as last approved, as JSONB
--     {employee_id: gross}: taken by payroll_off_cycle_paid_snapshot (BEFORE INSERT OR UPDATE, ENABLE ALWAYS, INVOKER)
--     from the run's lines at the status transition out of 'approved' (a reopen), on the row that transition writes.
--     For the app's roles (payroll_run_app_role; a trusted ops role writes it as given, so a restore keeps it, #1679
--     ops M), every other INSERT or UPDATE keeps it as it was (NULL on insert), whatever the statement says, so no app_user
--     write can set or move it (review #1679 L1: approved_amount, stamped from a reopened_at app_user may UPDATE, could
--     be forged). A re-snapshot never rises (review #1679b: a status flip by app_user over raised lines): each
--     employee keeps the LEAST of the old snapshot and the lines, nil when absent from it. After a run's pay date its gross may not rise above it (payrollOffCycleCorrection: bonus and
--     termination runs alike, review #1679 M).
--   approval_request_document_facts  (951:183, called by the 872 SECURITY DEFINER writers) names an off-cycle run in
--     its reference: '11/2026 bonus run, paid 2026-11-28' (its kind and pay date: a month may hold several); a regular
--     run's reference is unchanged
--     ('11/2026'). approvalDocuments.ts builds the same string (the REST raise compares nothing with it; it is the
--     reference an approver reads). The function stays plpgsql STABLE SECURITY INVOKER: 930's registry
--     (app_definer_reviews) hashes SECURITY DEFINER functions only, and no definer changes here, so no row is
--     needed. It runs inside those definers with their owner's rights, so its body is reviewed here: it reads
--     payroll_run_headers only, by the caller's company and document id, as before.
--
--   payroll_run_headers.cancelled_at  cancelOffCycleRun stamps it (cancelled_by came with 999f). Dev has the column
--     from 385; production does not (999f: "paid_at and cancelled_at ... are absent on prod too"), so the cancel
--     route would fail there with 42703. ADD COLUMN IF NOT EXISTS, no default: a no-op where the column exists (dev,
--     the CI baseline), catalogue-only where it is missing (prod). TIMESTAMPTZ is dev's type. Nothing reads it as
--     NOT NULL (getPayrollRun/mapRunRow tolerate NULL), and the old colour never names it.
--
-- OLD COLOUR (the previous release against this schema):
--   payroll_run_headers_history_guard  the old colour never deletes a header and inserts them as draft without
--     history, so it is never refused.
--   payroll_run_headers.off_cycle_paid_gross  it never names the column; its header writes pass through
--     payroll_off_cycle_paid_snapshot, which keeps the column as it was and snapshots only an off-cycle run leaving
--     'approved' (which the old colour never reopens).
--   insert/update/read  it never names payroll_off_cycle_employees; it creates no off-cycle run (insertMonthlyRun
--     writes run_kind 'regular' only), and its run-kind guard refuses to calculate, approve, post, reopen or print an
--     off-cycle run created by this release, so it never costs one without its inputs.
--   approval_request_document_facts  a regular run's reference is the same string as before; an off-cycle run's is
--     longer, which the old code only displays.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TABLE IF EXISTS public.payroll_off_cycle_employees;
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS cancelled_at;  (only where this file added it: prod)
--   DROP FUNCTION IF EXISTS public.payroll_off_cycle_employees_guard();
--   DROP TRIGGER IF EXISTS payroll_off_cycle_paid_snapshot ON public.payroll_run_headers;
--   DROP TRIGGER IF EXISTS payroll_run_headers_history_guard ON public.payroll_run_headers;
--   DROP FUNCTION IF EXISTS public.payroll_run_headers_history_guard();
--   DROP FUNCTION IF EXISTS public.payroll_run_app_role();
--   DROP FUNCTION IF EXISTS public.payroll_off_cycle_paid_snapshot();
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS off_cycle_paid_gross;
--   and re-run 951's approval_request_document_facts definition.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_run_headers
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.payroll_off_cycle_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id),
  run_id UUID NOT NULL REFERENCES public.payroll_run_headers(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.payroll_employees(id),
  component_id UUID NULL REFERENCES public.payroll_components(id),
  amount NUMERIC(14, 2) NULL CHECK (amount IS NULL OR amount > 0),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_off_cycle_employees_bonus_input CHECK ((component_id IS NULL) = (amount IS NULL)),
  CONSTRAINT payroll_off_cycle_employees_one_per_run UNIQUE (run_id, employee_id)
);

COMMENT ON TABLE public.payroll_off_cycle_employees IS
  'Who an off-cycle pay run pays (999x, wave 6 OC): a bonus row carries its 3605 earning and amount; a termination row neither. Written at run creation; a bonus amount may be corrected while the run is a draft.';

CREATE INDEX IF NOT EXISTS payroll_off_cycle_employees_company_run ON public.payroll_off_cycle_employees (company_id, run_id);

CREATE OR REPLACE FUNCTION public.payroll_off_cycle_employees_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h record;
BEGIN
  SELECT run_kind, off_cycle_reason, status INTO h
    FROM public.payroll_run_headers WHERE id = NEW.run_id AND company_id = NEW.company_id;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.component_id IS DISTINCT FROM OLD.component_id THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: only the amount changes (same company, run, employee and earning)'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Also held by the CHECK (amount > 0) and the NUMERIC(14, 2) column; stated here so the rule reads in one place.
    IF NEW.amount IS NULL OR NEW.amount <= 0 OR NEW.amount <> pg_catalog.round(NEW.amount, 2) THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: a bonus amount is more than R0, in whole cents' USING ERRCODE = 'check_violation';
    END IF;
    -- A draft only (delta L1): a calculated run's lines were costed on the old amount; the service sends the run back
    -- to draft and clears its lines before it changes an amount.
    IF NOT FOUND OR h.run_kind <> 'off_cycle' OR h.off_cycle_reason IS DISTINCT FROM 'bonus' OR h.status <> 'draft' THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: only a draft bonus run''s amount changes'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT FOUND OR h.run_kind <> 'off_cycle' OR h.status <> 'draft' THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: the run is not a draft off-cycle run of this company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_employees e WHERE e.id = NEW.employee_id AND e.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: the employee is not this company''s' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF h.off_cycle_reason = 'bonus' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_components c
       WHERE c.id = NEW.component_id AND c.company_id = NEW.company_id AND c.component_type = 'earning'
         AND pg_catalog.btrim(c.sars_source_code) = '3605'
    ) THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: a bonus row names one of this company''s 3605 earnings'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.component_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: a termination row names no component' USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payroll_off_cycle_employees_guard ON public.payroll_off_cycle_employees;
CREATE TRIGGER payroll_off_cycle_employees_guard BEFORE INSERT OR UPDATE ON public.payroll_off_cycle_employees
  FOR EACH ROW EXECUTE FUNCTION public.payroll_off_cycle_employees_guard();
ALTER TABLE public.payroll_off_cycle_employees ENABLE ALWAYS TRIGGER payroll_off_cycle_employees_guard;

-- What an off-cycle run paid each employee, as last approved (review #1679 M and L1): see WHAT above.
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS off_cycle_paid_gross JSONB NULL;
COMMENT ON COLUMN public.payroll_run_headers.off_cycle_paid_gross IS
  'Off-cycle runs (999x): each employee''s gross as last approved, {employee_id: gross}, taken by payroll_off_cycle_paid_snapshot when the run leaves approved (a reopen). Written by that trigger only.';

-- The application's roles (review #1679 ops M): the request role app_user, the service role app_service and their
-- login roles. Exact names, not membership: postgres may be a member of app_user (to SET ROLE), and is not bound.
CREATE OR REPLACE FUNCTION public.payroll_run_app_role() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT current_user IN ('app_user', 'app_service', 'isaflow_app', 'isaflow_service')
$$;

CREATE OR REPLACE FUNCTION public.payroll_off_cycle_paid_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- The app's roles only (review #1679 ops M): a trusted ops role (postgres, the migration and deploy roles) restores
  -- or edits the column as written; only a reopen (approved -> not approved) still snapshots for it.
  IF NOT public.payroll_run_app_role()
     AND NOT (TG_OP = 'UPDATE' AND OLD.run_kind = 'off_cycle' AND OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved'
              AND NEW.off_cycle_paid_gross IS NOT DISTINCT FROM OLD.off_cycle_paid_gross) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.off_cycle_paid_gross := NULL;
    RETURN NEW;
  END IF;
  IF OLD.run_kind = 'off_cycle' AND OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
    -- Never rises (review #1679b): a re-snapshot keeps, per employee, the LEAST of what was last snapshotted and the
    -- lines now; an employee absent from an existing snapshot stays nil. The first snapshot takes the lines as they are.
    -- A run approved before with no snapshot lost it below the service (review #1679d): every employee at nil, as
    -- payrollOffCycleCorrection.paidCaps fails closed.
    SELECT pg_catalog.jsonb_object_agg(s.employee_id::text,
             CASE WHEN OLD.off_cycle_paid_gross IS NULL
                       AND OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history) THEN 0
                  WHEN OLD.off_cycle_paid_gross IS NULL THEN s.gross
                  ELSE LEAST(s.gross, COALESCE((OLD.off_cycle_paid_gross ->> s.employee_id::text)::numeric, 0)) END)
      INTO NEW.off_cycle_paid_gross
      FROM (SELECT l.employee_id, pg_catalog.sum(l.gross_pay) AS gross
              FROM public.payroll_run_lines l WHERE l.run_id = OLD.id GROUP BY l.employee_id) s;
    -- No lines (a run reopened with none): the existing snapshot stands.
    NEW.off_cycle_paid_gross := COALESCE(NEW.off_cycle_paid_gross, OLD.off_cycle_paid_gross);
  ELSE
    NEW.off_cycle_paid_gross := OLD.off_cycle_paid_gross;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payroll_off_cycle_paid_snapshot ON public.payroll_run_headers;
CREATE TRIGGER payroll_off_cycle_paid_snapshot BEFORE INSERT OR UPDATE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_off_cycle_paid_snapshot();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_off_cycle_paid_snapshot;

-- A run's approval history is never removed, invented or grown outside a reopen (reviews #1679d-f). For the APP's
-- roles only (payroll_run_app_role: app_user, app_service and their login roles isaflow_app and isaflow_service), the
-- threat model being the application; trusted ops roles (postgres, which is NOSUPERUSER on Supabase, the migration and
-- deploy roles, supabase_admin) are not bound, so a restore (COPY fires ALWAYS row triggers, and pg_restore
-- --disable-triggers needs a superuser), a restore drill, a dev clone or a QA company delete still works (#1679 ops M).
--   DELETE  a header approved once (non-empty approval_history) is not deleted: cancel or reverse it instead.
--   INSERT  a new header carries no approval history and is not final (approved, paid).
--   UPDATE OF approval_history  append-only (the new value contains the old, #1679e), and it changes only in the
--     UPDATE that moves the run out of approved or paid, which is what reopenPayrollRun (its one writer) does (#1679f).
-- The Demo company stays exempt: scripts/lib/demoReseed reopens and wipes its runs, and may run under the app's role
-- (runOwnedContext); its money is not real.
CREATE OR REPLACE FUNCTION public.payroll_run_headers_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  co uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.company_id ELSE OLD.company_id END;
BEGIN
  IF NOT public.payroll_run_app_role() OR co = '00000000-0000-0000-0000-000000000001'::uuid THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.approval_history IS DISTINCT FROM OLD.approval_history THEN
      IF OLD.approval_history IS NOT NULL AND NOT COALESCE(NEW.approval_history @> OLD.approval_history, false) THEN
        RAISE EXCEPTION 'payroll_run_headers: a pay run''s approval history is only added to, never rewritten or cleared'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT (OLD.status IN ('approved', 'paid') AND NEW.status NOT IN ('approved', 'paid')) THEN
        RAISE EXCEPTION 'payroll_run_headers: a pay run''s approval history grows only when the run is reopened'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history) THEN
      RAISE EXCEPTION 'payroll_run_headers: a pay run that was approved before is not deleted; cancel it instead'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.approval_history IS NOT NULL AND NOT pg_catalog.isempty(NEW.approval_history)) OR NEW.status IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'payroll_run_headers: a new pay run starts without an approval history and is not final'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS payroll_run_headers_history_guard ON public.payroll_run_headers;
CREATE TRIGGER payroll_run_headers_history_guard BEFORE INSERT OR DELETE OR UPDATE OF approval_history ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_history_guard();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_run_headers_history_guard;

ALTER TABLE public.payroll_off_cycle_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_off_cycle_employees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payroll_off_cycle_employees;
CREATE POLICY tenant_isolation ON public.payroll_off_cycle_employees FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON public.payroll_off_cycle_employees FROM app_user;
GRANT SELECT ON public.payroll_off_cycle_employees TO app_user;
GRANT INSERT (company_id, run_id, employee_id, component_id, amount, created_by) ON public.payroll_off_cycle_employees TO app_user;
GRANT UPDATE (amount) ON public.payroll_off_cycle_employees TO app_user;

CREATE OR REPLACE FUNCTION public.approval_request_document_facts(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS TABLE (amount pg_catalog.numeric, reference pg_catalog.text, digest pg_catalog.text)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_document_type = 'pay_run' THEN
    RETURN QUERY SELECT h.total_gross,
      pg_catalog.lpad(h.period_month::pg_catalog.text, 2, '0') || '/' || h.period_year::pg_catalog.text
        || CASE WHEN h.run_kind = 'off_cycle' THEN ' ' || COALESCE(h.off_cycle_reason, 'off-cycle') || ' run, paid '
             || pg_catalog.to_char(COALESCE(h.run_date, h.period_end), 'YYYY-MM-DD') ELSE '' END,
      h.approval_plan_hash
    FROM public.payroll_run_headers h
    WHERE h.id = p_document_id AND h.company_id = p_company_id
      AND h.prepared_by IS NOT NULL AND h.approval_plan_hash IS NOT NULL;
  ELSE
    RETURN QUERY SELECT f.amount, f.reference, f.digest
    FROM public.approval_request_document_facts_pre_payroll_951(
      p_company_id, p_document_type, p_document_id
    ) f;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.approval_request_document_facts(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) FROM PUBLIC;

SELECT public.app_service_sync_policies();
