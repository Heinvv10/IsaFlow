-- 999X: off-cycle bonus and termination runs (wave 6 OC). Expand-only.
--
-- WHAT.
--   payroll_off_cycle_employees  who an off-cycle run pays, written once when the run is created, never changed:
--     bonus        one row per employee, with the annual-payment earning (a 3605 component of the company) and the
--                  amount; the line pays that alone (no salary, recurring component, loan or deduction);
--     termination  one row per employee, with neither: the line pays the leaver's termination pay-outs.
--     Off-cycle inputs live here and NOT as once-off payroll_employee_components: the run reader pays a once-off
--     dated in its month whatever its end (payrollComponentService), so a bonus written there would be paid again by
--     the month's regular run when that run is reopened and recalculated.
--     payroll_off_cycle_employees_guard  a BEFORE INSERT trigger (INVOKER, under the caller's RLS): the run is this
--     company's, an off-cycle run, still a draft; the employee is this company's; a bonus row names one of this
--     company's 3605 earnings and a termination row names none. app_user may INSERT and SELECT only.
--   approval_request_document_facts  (951:183, called by the 872 SECURITY DEFINER writers) names an off-cycle run in
--     its reference: '11/2026 bonus run' / '11/2026 termination run'; a regular run's reference is unchanged
--     ('11/2026'). approvalDocuments.ts builds the same string (the REST raise compares nothing with it; it is the
--     reference an approver reads). The function stays plpgsql STABLE SECURITY INVOKER: 930's registry
--     (app_definer_reviews) hashes SECURITY DEFINER functions only, and no definer changes here, so no row is
--     needed. It runs inside those definers with their owner's rights, so its body is reviewed here: it reads
--     payroll_run_headers only, by the caller's company and document id, as before.
--
-- OLD COLOUR (the previous release against this schema):
--   insert/update/read  it never names payroll_off_cycle_employees; it creates no off-cycle run (insertMonthlyRun
--     writes run_kind 'regular' only), and its run-kind guard refuses to calculate, approve, post, reopen or print an
--     off-cycle run created by this release, so it never costs one without its inputs.
--   approval_request_document_facts  a regular run's reference is the same string as before; an off-cycle run's is
--     longer, which the old code only displays.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TABLE IF EXISTS public.payroll_off_cycle_employees;
--   DROP FUNCTION IF EXISTS public.payroll_off_cycle_employees_guard();
--   and re-run 951's approval_request_document_facts definition.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
  'Who an off-cycle pay run pays (999X, wave 6 OC): a bonus row carries its 3605 earning and amount; a termination row neither. Written at run creation only.';

CREATE INDEX IF NOT EXISTS payroll_off_cycle_employees_company_run ON public.payroll_off_cycle_employees (company_id, run_id);

CREATE OR REPLACE FUNCTION public.payroll_off_cycle_employees_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h record;
BEGIN
  SELECT run_kind, off_cycle_reason, status INTO h
    FROM public.payroll_run_headers WHERE id = NEW.run_id AND company_id = NEW.company_id;
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
CREATE TRIGGER payroll_off_cycle_employees_guard BEFORE INSERT ON public.payroll_off_cycle_employees
  FOR EACH ROW EXECUTE FUNCTION public.payroll_off_cycle_employees_guard();
ALTER TABLE public.payroll_off_cycle_employees ENABLE ALWAYS TRIGGER payroll_off_cycle_employees_guard;

ALTER TABLE public.payroll_off_cycle_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_off_cycle_employees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payroll_off_cycle_employees;
CREATE POLICY tenant_isolation ON public.payroll_off_cycle_employees FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON public.payroll_off_cycle_employees FROM app_user;
GRANT SELECT ON public.payroll_off_cycle_employees TO app_user;
GRANT INSERT (company_id, run_id, employee_id, component_id, amount, created_by) ON public.payroll_off_cycle_employees TO app_user;

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
        || CASE WHEN h.run_kind = 'off_cycle' THEN ' ' || COALESCE(h.off_cycle_reason, 'off-cycle') || ' run' ELSE '' END,
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
