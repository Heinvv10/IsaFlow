-- 1054: pay run header DELETE rules and a fixed employee company (wave 7 RH: W9, W10, W35). Expand-only.
--
-- WHY.
--   W9  payroll_run_headers had one app_user policy, tenant_isolation FOR ALL: USING (member of the company), WITH CHECK
--       (the active company). A DELETE is judged by USING alone, so a user of two companies, with A active, could delete
--       B's headers (wave-6 Progress 11-19, breaker #1673). payroll_employees had the same FOR ALL shape.
--   W10 a dual-member user could UPDATE payroll_employees.company_id: USING admitted B's employee and WITH CHECK
--       admitted the new value A, so B's employee (with its history) moved to A.
--   W35 a header approved once and never reopened has an empty approval_history, so 999x's history guard let app_user
--       DELETE it and INSERT it again under the same id, which reset its off-cycle paid snapshot and payday (999x
--       ACCEPTED LIMITS, re-review L3 of #1679).
--
-- WHAT.
--   1. Both tables: tenant_isolation (FOR ALL) is split into one app_user policy per command, as 1011 did for
--      payroll_run_lines:
--        select  USING (MEMBER): unchanged, the rows the old USING admitted. 999n's payroll_run_final_state emulates the
--                header's read policy for its caller; the read rule is identical, so the emulation stays exact and no
--                SECURITY DEFINER changes (no app_definer_reviews row).
--        insert  WITH CHECK (ACTIVE)
--        update  USING (ACTIVE), WITH CHECK (ACTIVE)
--        delete  USING (ACTIVE)
--        MEMBER  company_id is a company of auth.uid() (company_users);
--        ACTIVE  company_id = app.current_company_id() AND MEMBER.
--      The new MEMBER term in WITH CHECK changes nothing for a real session: every app_user entry point (withAuth,
--      bearerPipeline / MCP, companyOwnTx, auditTx, the budget and intercompany jobs) sets the active company only for
--      a member user. app_service keeps its USING (true) mirrors (app_service_sync_policies(), below).
--   2. payroll_employees_company_fixed: BEFORE UPDATE OF company_id, ENABLE ALWAYS, INVOKER. An employee's company
--      never changes, for every role but a SUPERUSER session (999n's exemption: a superuser can disable any trigger
--      anyway). It binds the BYPASSRLS roles (platform_admin, migration_admin, production's postgres) that the policy
--      does not.
--   3. payroll_run_headers_final_no_delete: BEFORE DELETE, ENABLE ALWAYS, INVOKER. A FINAL header (R-035 isPayRunFinal,
--      payRunFinalSql: status approved or paid with approved_at or approval_grandfathered_at) is not deleted: reopen or
--      cancel it first. This closes W35 (an approved, never-reopened run has approved_at or the grandfathered stamp).
--      Exempt:
--        * a SUPERUSER session (999n);
--        * a DELETE fired from inside another trigger (pg_trigger_depth() > 1), which is the ON DELETE CASCADE of a
--          company delete. Coordinator ruling (2026-11-25, option B), as 999x's history guard and 999n's line freeze
--          already allow it: deleting a tenant removes its whole history. Census (PR body): the only FK that cascades
--          into payroll_run_headers is payroll_run_headers_company_id_fkey (companies, ON DELETE CASCADE); the two
--          gl_journal_entries FKs are NO ACTION / SET NULL; no function in the database deletes headers; app_user
--          holds only SELECT on companies, so no app session reaches the cascade.
--      Not exempt: the Demo company. The reseed reopens its final runs first (scripts/lib/demoReseed/payrollFinal.ts
--      reopenFinalRuns: status calculated, stamps cleared), so they are no longer final when wipePlan deletes them;
--      reopen keeps approval_history, which 999x's history guard exempts for the Demo.
--
-- OLD COLOUR (the release before this one, against this schema). Writer census in the PR body:
--   headers    the one app DELETE is payrollRunDelete (a never-calculated draft, by id and the request's company); every
--              INSERT and UPDATE names the request's company (withAuth / bearer), a company the user is a member of
--              and the active one; approve, reopen and the definers (872, owned by migration_admin) are unaffected.
--   employees  every UPDATE names the request's company and none sets company_id; INSERT is the request's company.
--   reseed     the old colour's reseed also reopens before its wipe (999n), so it is not refused.
--   So it reads and writes the same rows as before.
--
-- LOCKS. DROP/CREATE POLICY take ACCESS EXCLUSIVE on each table for an instant; CREATE OR REPLACE TRIGGER and ENABLE
-- ALWAYS take SHARE ROW EXCLUSIVE. All bounded by lock_timeout. No scan, no backfill.
--
-- Rollback (down SQL; code needs no rollback):
--   DROP TRIGGER IF EXISTS payroll_run_headers_final_no_delete ON public.payroll_run_headers;
--   DROP TRIGGER IF EXISTS payroll_employees_company_fixed ON public.payroll_employees;
--   DROP FUNCTION IF EXISTS public.payroll_run_headers_final_no_delete(), public.payroll_employees_company_fixed();
--   for t in payroll_run_headers, payroll_employees: DROP POLICY IF EXISTS tenant_isolation_{select,insert,update,delete}
--   ON public.<t>; CREATE POLICY tenant_isolation ON public.<t> FOR ALL TO app_user
--     USING (company_id IN (SELECT company_users.company_id FROM company_users WHERE company_users.user_id = auth.uid()))
--     WITH CHECK (company_id = app.current_company_id());
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';

-- ── 1. one app_user policy per command ──────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS tenant_isolation ON public.payroll_run_headers;
DROP POLICY IF EXISTS tenant_isolation_select ON public.payroll_run_headers;
DROP POLICY IF EXISTS tenant_isolation_insert ON public.payroll_run_headers;
DROP POLICY IF EXISTS tenant_isolation_update ON public.payroll_run_headers;
DROP POLICY IF EXISTS tenant_isolation_delete ON public.payroll_run_headers;

CREATE POLICY tenant_isolation_select ON public.payroll_run_headers
  FOR SELECT TO app_user
  USING (company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()));
CREATE POLICY tenant_isolation_insert ON public.payroll_run_headers
  FOR INSERT TO app_user
  WITH CHECK (company_id = app.current_company_id()
    AND company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()));
CREATE POLICY tenant_isolation_update ON public.payroll_run_headers
  FOR UPDATE TO app_user
  USING (company_id = app.current_company_id()
    AND company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()))
  WITH CHECK (company_id = app.current_company_id()
    AND company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()));
CREATE POLICY tenant_isolation_delete ON public.payroll_run_headers
  FOR DELETE TO app_user
  USING (company_id = app.current_company_id()
    AND company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()));

DROP POLICY IF EXISTS tenant_isolation ON public.payroll_employees;
DROP POLICY IF EXISTS tenant_isolation_select ON public.payroll_employees;
DROP POLICY IF EXISTS tenant_isolation_insert ON public.payroll_employees;
DROP POLICY IF EXISTS tenant_isolation_update ON public.payroll_employees;
DROP POLICY IF EXISTS tenant_isolation_delete ON public.payroll_employees;

CREATE POLICY tenant_isolation_select ON public.payroll_employees
  FOR SELECT TO app_user
  USING (company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()));
CREATE POLICY tenant_isolation_insert ON public.payroll_employees
  FOR INSERT TO app_user
  WITH CHECK (company_id = app.current_company_id()
    AND company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()));
CREATE POLICY tenant_isolation_update ON public.payroll_employees
  FOR UPDATE TO app_user
  USING (company_id = app.current_company_id()
    AND company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()))
  WITH CHECK (company_id = app.current_company_id()
    AND company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()));
CREATE POLICY tenant_isolation_delete ON public.payroll_employees
  FOR DELETE TO app_user
  USING (company_id = app.current_company_id()
    AND company_id IN (SELECT company_users.company_id FROM public.company_users WHERE company_users.user_id = auth.uid()));

ALTER TABLE public.payroll_run_headers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_run_headers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_employees FORCE ROW LEVEL SECURITY;

-- ── 2. an employee's company is fixed ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_employees_company_fixed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'payroll_employees: an employee''s company is fixed (create the employee in the other company instead)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER payroll_employees_company_fixed
  BEFORE UPDATE OF company_id ON public.payroll_employees
  FOR EACH ROW EXECUTE FUNCTION public.payroll_employees_company_fixed();
ALTER TABLE public.payroll_employees ENABLE ALWAYS TRIGGER payroll_employees_company_fixed;

-- ── 3. a final header is not deleted ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_run_headers_final_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' OR pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF COALESCE(OLD.status, '') IN ('approved', 'paid')
     AND COALESCE(OLD.approved_at, OLD.approval_grandfathered_at) IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_run_headers: a final pay run is not deleted (reopen or cancel it first)'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$$;

CREATE OR REPLACE TRIGGER payroll_run_headers_final_no_delete
  BEFORE DELETE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_final_no_delete();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_run_headers_final_no_delete;

SELECT public.app_service_sync_policies();

-- The four policies are the only limit for app_user and PUBLIC on each table: refuse to finish if any other exists
-- (a stray permissive policy would OR away the tenant check).
DO $$
DECLARE
  v_stray text;
BEGIN
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ') INTO v_stray
    FROM pg_catalog.pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename IN ('payroll_run_headers', 'payroll_employees')
     AND p.policyname NOT IN ('tenant_isolation_select', 'tenant_isolation_insert', 'tenant_isolation_update',
                              'tenant_isolation_delete')
     AND (p.roles && ARRAY['app_user', 'public']::name[]);
  IF v_stray IS NOT NULL THEN
    RAISE EXCEPTION '1054: app_user/PUBLIC policies besides tenant_isolation_*: %', v_stray;
  END IF;
END
$$;
