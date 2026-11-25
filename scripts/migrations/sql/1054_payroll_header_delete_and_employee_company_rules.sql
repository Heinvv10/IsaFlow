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
--   2. payroll_employees_company_fixed and payroll_run_headers_company_fixed (one INVOKER function,
--      payroll_row_company_fixed; BEFORE UPDATE, ENABLE ALWAYS): a row's company never changes, for every role but a
--      SUPERUSER session (999n's exemption: a superuser can disable any trigger anyway). It binds the BYPASSRLS roles
--      (platform_admin, migration_admin, production's postgres) that the policy does not. 999n already froze a FINAL
--      header's company; this covers every header (security review of 4bbded8c0b: a reopened client header moved into
--      the Demo would have met rule 3b's Demo exemption), so the Demo exemption below reaches only rows born in the
--      Demo.
--   3. W35, closed by EVIDENCE, not by the current state (security review of 22b1532807: approve, then a status flip
--      out of approved, then DELETE and INSERT again, would have passed a rule that judged only the current state).
--      payroll_run_headers.ever_final_at (new, NULL) is kept by payroll_run_headers_final_evidence (BEFORE INSERT OR
--      UPDATE, ENABLE ALWAYS, INVOKER): NULL on every INSERT but a trusted restore's (payroll_run_trusted_restore,
--      999x: it keeps what it writes); on every UPDATE, by any role, it keeps its old value, or takes the clock when
--      the old or the new row is FINAL (R-035 isPayRunFinal, payRunFinalSql: status approved or paid with approved_at
--      or approval_grandfathered_at). So every exit from final (reopen, a forged status flip, a cancel) leaves it set,
--      and no statement can clear it. Not backfilled: a row final today is stamped by the UPDATE that takes it out,
--      and the other evidence below covers rows that left final before this file.
--      payroll_run_headers_final_no_delete (BEFORE DELETE, ENABLE ALWAYS, INVOKER), for every non-superuser:
--        a. a FINAL header is not deleted, in every company (reopen or cancel it first);
--        b. outside the Demo company, a header with past-approval evidence is not deleted: ever_final_at,
--           reopened_at, approved_at or approval_grandfathered_at set, or a non-empty approval_history. The app has no
--           path that deletes such a run (payrollRunDelete takes never-calculated drafts; off-cycle cancel refuses a
--           run that was ever approved), and a never-approved draft or calculated run still deletes.
--      Exempt:
--        * a SUPERUSER session (999n);
--        * a DELETE fired from inside another trigger (pg_trigger_depth() > 1), which is the ON DELETE CASCADE of a
--          company delete. Coordinator ruling (2026-11-25, option B; spec 4 RH and grill F6 said "refused"), as 999x's
--          history guard and 999n's line freeze already allow it: deleting a tenant removes its whole history. Census
--          (PR body): the only FK that cascades into payroll_run_headers is payroll_run_headers_company_id_fkey
--          (companies, ON DELETE CASCADE); the two gl_journal_entries FKs are NO ACTION / SET NULL; no function in
--          the database deletes headers; app_user holds only SELECT on companies, so no app session reaches it.
--        * rule b only, the Demo company (a literal id: no GUC or role check, which the app pool could forge; 999n's
--          reasoning). The Demo reseed runs as production's postgres, NOSUPERUSER, so it is bound: it reopens the
--          Demo's final runs first (scripts/lib/demoReseed/payrollFinal.ts reopenFinalRuns), which satisfies rule a,
--          and then deletes runs that carry evidence. This is exactly the exemption 999x's history guard already gives
--          the Demo for approval_history, so it reaches no row that was not deletable before; the Demo holds no real
--          money. Rule a still binds the Demo. With every header's company fixed (2 above), the exemption reaches only
--          rows created in the Demo. A role-based path for the reseed was rejected: the app pool can SET ROLE and
--          set_config('role', ...) inside a transaction, so a rule on the role is forgeable where a fixed company id is
--          not (999n, 999x); a SECURITY DEFINER wipe would need its own unforgeable caller test for the same reason.
--
-- OLD COLOUR (the release before this one, against this schema). Writer census in the PR body:
--   headers    the one app DELETE is payrollRunDelete (a never-calculated draft, by id and the request's company); every
--              INSERT and UPDATE names the request's company (withAuth / bearer), a company the user is a member of
--              and the active one; approve, reopen and the definers (872, owned by migration_admin) are unaffected.
--   employees  every UPDATE names the request's company and none sets company_id; INSERT is the request's company.
--   company    no header or employee writer, old or new, changes company_id (census in the PR body).
--   reseed     the old colour's reseed also reopens before its wipe (999n), so it is not refused.
--   ever_final_at  the old colour never names it (no SELECT * that is written back); its header writes pass through
--              the evidence trigger, which keeps or stamps the column itself.
--   So it reads and writes the same rows as before.
--
-- LOCKS. DROP/CREATE POLICY take ACCESS EXCLUSIVE on each table for an instant; CREATE OR REPLACE TRIGGER and ENABLE
-- ALWAYS take SHARE ROW EXCLUSIVE; ADD COLUMN (nullable, no default) is catalogue-only under ACCESS EXCLUSIVE for an
-- instant. All bounded by lock_timeout. No scan, no backfill.
--
-- Rollback (down SQL; code needs no rollback):
--   DROP TRIGGER IF EXISTS payroll_run_headers_final_no_delete ON public.payroll_run_headers;
--   DROP TRIGGER IF EXISTS payroll_run_headers_final_evidence ON public.payroll_run_headers;
--   DROP FUNCTION IF EXISTS public.payroll_run_headers_final_evidence();
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS ever_final_at;
--   DROP TRIGGER IF EXISTS payroll_employees_company_fixed ON public.payroll_employees;
--   DROP TRIGGER IF EXISTS payroll_run_headers_company_fixed ON public.payroll_run_headers;
--   DROP FUNCTION IF EXISTS public.payroll_run_headers_final_no_delete(), public.payroll_row_company_fixed();
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

-- ── 2. a row's company is fixed (employees and pay run headers) ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_row_company_fixed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION '%: a row''s company is fixed (create it in the other company instead)', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Every UPDATE, not UPDATE OF company_id: the column list is the statement's SET list, so it would miss a value
-- changed by another BEFORE trigger.
CREATE OR REPLACE TRIGGER payroll_employees_company_fixed
  BEFORE UPDATE ON public.payroll_employees
  FOR EACH ROW EXECUTE FUNCTION public.payroll_row_company_fixed();
ALTER TABLE public.payroll_employees ENABLE ALWAYS TRIGGER payroll_employees_company_fixed;
CREATE OR REPLACE TRIGGER payroll_run_headers_company_fixed
  BEFORE UPDATE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_row_company_fixed();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_run_headers_company_fixed;

-- ── 3. a header that was ever final is not deleted ─────────────────────────────────────────────────────────────

-- Evidence a run was once final, kept by the trigger below, never by the statement.
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS ever_final_at TIMESTAMPTZ NULL;
COMMENT ON COLUMN public.payroll_run_headers.ever_final_at IS
  'Wave 7 RH (1054): when this run was first seen final (approved/paid with an approval stamp), by any UPDATE that enters or leaves that state. Written by payroll_run_headers_final_evidence only (a trusted restore keeps it); never cleared. A header with it set is not deleted.';

CREATE OR REPLACE FUNCTION public.payroll_run_headers_final_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  was_final boolean;
  is_final boolean := COALESCE(NEW.status, '') IN ('approved', 'paid')
                      AND COALESCE(NEW.approved_at, NEW.approval_grandfathered_at) IS NOT NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A restore (trusted identity, 999x) keeps the value it writes; any other INSERT starts with none.
    IF NOT public.payroll_run_trusted_restore(TG_RELID) THEN
      NEW.ever_final_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  was_final := COALESCE(OLD.status, '') IN ('approved', 'paid')
               AND COALESCE(OLD.approved_at, OLD.approval_grandfathered_at) IS NOT NULL;
  NEW.ever_final_at := COALESCE(OLD.ever_final_at,
    CASE WHEN was_final OR is_final THEN pg_catalog.clock_timestamp() END);
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER payroll_run_headers_final_evidence
  BEFORE INSERT OR UPDATE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_final_evidence();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_run_headers_final_evidence;

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
  IF OLD.company_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid
     AND (OLD.ever_final_at IS NOT NULL OR OLD.reopened_at IS NOT NULL
          OR OLD.approved_at IS NOT NULL OR OLD.approval_grandfathered_at IS NOT NULL
          OR (OLD.approval_history IS NOT NULL AND NOT pg_catalog.isempty(OLD.approval_history))) THEN
    RAISE EXCEPTION 'payroll_run_headers: a pay run that was approved before is not deleted; cancel it instead'
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
