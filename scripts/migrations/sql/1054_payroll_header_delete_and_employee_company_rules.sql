-- 1054: pay run header DELETE and TRUNCATE rules, fixed row ids and companies (wave 7 RH: W9, W10, W35). Expand-only.
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
--                SECURITY DEFINER changes for it.
--        insert  WITH CHECK (ACTIVE)
--        update  USING (ACTIVE), WITH CHECK (ACTIVE)
--        delete  USING (ACTIVE)
--        MEMBER  company_id is a company of auth.uid() (company_users);
--        ACTIVE  company_id = app.current_company_id() AND MEMBER.
--      The new MEMBER term in WITH CHECK changes nothing for a real session: every app_user entry point (withAuth,
--      bearerPipeline / MCP, companyOwnTx, auditTx, the budget and intercompany jobs) sets the active company only for
--      a member user. app_service keeps its USING (true) mirrors (app_service_sync_policies(), below).
--   2. payroll_employees_company_fixed and payroll_run_headers_company_fixed (one INVOKER function,
--      payroll_row_company_fixed; BEFORE UPDATE, ENABLE ALWAYS): a row's id and company never change, for every role
--      but a SUPERUSER session (999n's exemption: a superuser can disable any trigger anyway). It binds the BYPASSRLS
--      roles (platform_admin, migration_admin, production's postgres) that the policy does not. 999n froze a FINAL
--      header's company but not its id; this covers every header: a reopened client header moved into the Demo
--      (security review of 4bbded8c0b) would have met rule 3b's Demo exemption, and an approved header renamed to a
--      new id (breaker B3 of fb88f3fd9d) left its old id free for a fresh row. So the Demo exemption reaches only rows
--      born in the Demo, and an id once approved stays on its row.
--   3. W35, closed by EVIDENCE, not by the current state (security review of 22b1532807).
--      payroll_run_headers.approval_evidence_at (new) is kept by payroll_run_headers_approval_evidence (BEFORE INSERT
--      OR UPDATE, ENABLE ALWAYS, INVOKER): NULL on every untrusted INSERT; on UPDATE it keeps its old value, or takes
--      the clock when the old or the new row is FINAL (R-035 isPayRunFinal, payRunFinalSql: status approved or paid
--      with approved_at or approval_grandfathered_at), so every exit from final (reopen, a forged status flip, a
--      cancel) leaves it set; only a trusted identity (payroll_run_trusted_restore) may set it, and no statement
--      clears it. Rows that left final before this file: a fail-closed backfill (breaker B5) stamps every
--      row with any approval trace and every cancelled row (see the UPDATE). So every reopened row carries it too,
--      and clearing reopened_at gains nothing (breaker B4).
--      payroll_run_headers_final_no_delete (BEFORE DELETE, ENABLE ALWAYS, INVOKER), for every non-superuser:
--        a. a FINAL header is not deleted, in every company (reopen or cancel it first);
--        b. outside the Demo company, a header with past-approval evidence is not deleted: approval_evidence_at,
--           reopened_at, approved_at or approval_grandfathered_at set, or a non-empty approval_history. The app has no
--           path that deletes such a run (payrollRunDelete takes never-calculated drafts and judges the same evidence
--           first, for a 409; off-cycle cancel refuses a run that was ever approved); a never-approved draft deletes.
--      payroll_run_headers_no_truncate (BEFORE TRUNCATE, FOR EACH STATEMENT, ENABLE ALWAYS) refuses TRUNCATE to every
--      non-superuser (breaker B2: a TRUNCATE fires no row trigger), and migration_admin loses TRUNCATE on the table.
--      Exempt:
--        * a SUPERUSER session (999n);
--        * the ON DELETE CASCADE of a company delete: a DELETE nested in another trigger (pg_trigger_depth() > 1)
--          whose company row no longer exists, read past RLS by payroll_company_row_exists (SECURITY DEFINER, owned
--          by postgres like the tables and every other 1054 function, app_definer_reviews row). Nesting alone is not enough (breaker B1 of fb88f3fd9d: a
--          role with TEMP fired a DELETE from a pg_temp trigger). Coordinator ruling (2026-11-25, option B; spec 4 RH
--          and grill F6 said "refused"), as 999x's history guard and 999n's line freeze already allow it: deleting a
--          tenant removes its whole history. Census (PR body): the only FK that cascades into payroll_run_headers is
--          payroll_run_headers_company_id_fkey (companies, ON DELETE CASCADE); the two gl_journal_entries FKs are NO
--          ACTION / SET NULL; app_user holds only SELECT on companies. A company's id is fixed (companies_id_fixed,
--          BEFORE UPDATE, ENABLE ALWAYS, every non-superuser; breaker H of 5ef58a1b12), so "the company row is gone"
--          cannot be faked by moving the row's id for one statement.
--        * rule b only, the Demo company (a literal id: no GUC or role check, which the app pool could forge; 999n's
--          reasoning). The Demo reseed runs as production's postgres, NOSUPERUSER, so it is bound: it reopens the
--          Demo's final runs first (scripts/lib/demoReseed/payrollFinal.ts reopenFinalRuns), which satisfies rule a,
--          and then deletes runs that carry evidence. This is exactly the exemption 999x's history guard already gives
--          the Demo for approval_history; the Demo holds no real money. Rule a still binds the Demo. With every
--          header's id and company fixed (2 above), the exemption reaches only rows created in the Demo. A role-based
--          path for the reseed was rejected: the app pool can SET ROLE and set_config('role', ...) inside a
--          transaction, so a rule on the role is forgeable where a fixed company id is not (999n, 999x).
--      Not closed here (stated): the table's owner (postgres on production) can DISABLE TRIGGER; OWN (W7) moves
--      ownership off the pool roles.
--
-- OLD COLOUR (the release before this one, against this schema). Writer census in the PR body:
--   headers    the one app DELETE is payrollRunDelete (a never-calculated draft, by id and the request's company); every
--              INSERT and UPDATE names the request's company (withAuth / bearer), a company the user is a member of
--              and the active one; approve, reopen and the definers (872, owned by migration_admin) are unaffected.
--   employees  every UPDATE names the request's company and none sets company_id; INSERT is the request's company.
--   company    no header or employee writer, old or new, changes company_id (census in the PR body).
--   reseed     the old colour's reseed also reopens before its wipe (999n), so it is not refused.
--   approval_evidence_at  the old colour never names it (no SELECT * that is written back); its header writes pass
--              through the evidence trigger, which keeps or stamps the column itself. It never TRUNCATEs headers and
--              never changes a header's, an employee's or a company's id.
--   So it reads and writes the same rows as before.
--
-- LOCKS. DROP/CREATE POLICY take ACCESS EXCLUSIVE on each table for an instant; CREATE OR REPLACE TRIGGER and ENABLE
-- ALWAYS take SHARE ROW EXCLUSIVE; ADD COLUMN (nullable, no default) is catalogue-only under ACCESS EXCLUSIVE for an
-- instant. All bounded by lock_timeout. One backfill UPDATE (row locks on the rows with an approval trace; payroll
-- headers are a small table), bounded by statement_timeout.
--
-- Rollback (down SQL; code needs no rollback):
--   DROP TRIGGER IF EXISTS payroll_run_headers_final_no_delete ON public.payroll_run_headers;
--   DROP TRIGGER IF EXISTS payroll_run_headers_approval_evidence ON public.payroll_run_headers;
--   DROP TRIGGER IF EXISTS payroll_run_headers_no_truncate ON public.payroll_run_headers;
--   DROP FUNCTION IF EXISTS public.payroll_run_headers_approval_evidence(), public.payroll_run_headers_no_truncate(),
--     public.payroll_company_row_exists(uuid);
--   DELETE FROM public.app_definer_reviews WHERE signature = 'payroll_company_row_exists(uuid)';
--   DROP TRIGGER IF EXISTS companies_id_fixed ON public.companies; DROP FUNCTION IF EXISTS public.companies_id_fixed();
--   GRANT TRUNCATE ON public.payroll_run_headers TO migration_admin;
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS approval_evidence_at;
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

-- ── 2. a row's id and company are fixed (employees and pay run headers) ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.payroll_row_company_fixed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION '%: a row''s id and company are fixed (create it in the other company instead)', TG_TABLE_NAME
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

-- ── 3. a header that was ever approved is not deleted ───────────────────────────────────────────────────────────

ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS approval_evidence_at TIMESTAMPTZ NULL;
COMMENT ON COLUMN public.payroll_run_headers.approval_evidence_at IS
  'Wave 7 RH (1054): when this run first carried evidence that it was, or may have been, approved. Set by payroll_run_headers_approval_evidence when an UPDATE enters or leaves final (approved/paid with an approval stamp); backfilled by 1054, fail closed, for every row with any trace of an approval and every cancelled row. Never cleared by a statement. A header with it set is not deleted (outside the Demo). It is NOT proof of approval: read approval_history and the stamps for that.';

-- Fail-closed backfill (breaker B5 of fb88f3fd9d): a run that left final before 1054 has no approval_evidence_at. A
-- row that carries any trace an approval leaves (the stamps, approved_by, lines_confirmed_at (718: stamped at approval,
-- kept by reopen), reopened_at, a non-empty approval_history, off_cycle_payday_at (999x: frozen at the first
-- approval), a journal link) or whose status is approved, paid or cancelled (a cancel from final could clear every
-- other trace below the service) is stamped. Run as the migration role (the table's owner: a trusted identity for
-- 999x's snapshot trigger, and the figures and stamps 999n freezes are not touched). Re-runs touch nothing.
SET LOCAL statement_timeout = '120s';
-- Round 2 (breaker L of 5ef58a1b12) adds approved_plan_hash (951: written at approval), approved_taxed_employees (925:
-- written at reopen), approval_revision (951: written by reopen AND by every recalculation, so it also marks calculated
-- runs that were never approved: fail closed, and no path deletes a calculated run), paid_at (read through to_jsonb:
-- dev has the column, production does not, 999f) and a payslip delivery or bank file built for the run (999o, 999h).
UPDATE public.payroll_run_headers h
   SET approval_evidence_at = COALESCE(h.approved_at, h.approval_grandfathered_at, h.reopened_at, h.lines_confirmed_at,
                                       h.cancelled_at, h.updated_at, pg_catalog.now())
 WHERE h.approval_evidence_at IS NULL
   AND (h.status IN ('approved', 'paid', 'cancelled')
        OR h.approved_at IS NOT NULL OR h.approval_grandfathered_at IS NOT NULL OR h.approved_by IS NOT NULL
        OR h.lines_confirmed_at IS NOT NULL OR h.reopened_at IS NOT NULL OR h.off_cycle_payday_at IS NOT NULL
        OR h.journal_entry_id IS NOT NULL OR h.posted_journal_entry_id IS NOT NULL
        OR h.approved_plan_hash IS NOT NULL OR h.approved_taxed_employees IS NOT NULL OR h.approval_revision IS NOT NULL
        OR (pg_catalog.to_jsonb(h) ->> 'paid_at') IS NOT NULL
        OR (h.approval_history IS NOT NULL AND NOT pg_catalog.isempty(h.approval_history))
        OR EXISTS (SELECT 1 FROM public.payslip_deliveries d WHERE d.run_id = h.id)
        OR EXISTS (SELECT 1 FROM public.payroll_bank_files f WHERE f.run_id = h.id));

-- The column is the trigger's: an untrusted INSERT starts with none; an UPDATE, by every role, keeps the old value,
-- takes the clock when the old or the new row is final, and only a trusted identity (payroll_run_trusted_restore, 999x:
-- a superuser, migration_admin or the owner: a restore, or this file's backfill on a re-run) may set it. No statement
-- clears it (a superuser could only by disabling the trigger).
CREATE OR REPLACE FUNCTION public.payroll_run_headers_approval_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  trusted boolean := public.payroll_run_trusted_restore(TG_RELID);
  was_final boolean;
  is_final boolean := COALESCE(NEW.status, '') IN ('approved', 'paid')
                      AND COALESCE(NEW.approved_at, NEW.approval_grandfathered_at) IS NOT NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT trusted THEN
      NEW.approval_evidence_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  was_final := COALESCE(OLD.status, '') IN ('approved', 'paid')
               AND COALESCE(OLD.approved_at, OLD.approval_grandfathered_at) IS NOT NULL;
  NEW.approval_evidence_at := COALESCE(OLD.approval_evidence_at,
    CASE WHEN trusted THEN NEW.approval_evidence_at END,
    CASE WHEN was_final OR is_final THEN pg_catalog.clock_timestamp() END);
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER payroll_run_headers_approval_evidence
  BEFORE INSERT OR UPDATE ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_approval_evidence();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_run_headers_approval_evidence;

-- Whether a company row still exists, read past RLS (breaker B1 of fb88f3fd9d): the DELETE rule below exempts a
-- company delete's ON DELETE CASCADE, and a nested DELETE alone (pg_trigger_depth() > 1) is no proof of one: a role
-- with TEMP can fire a DELETE from a pg_temp trigger. The cascade runs after its company row is gone; any other nested
-- DELETE finds it still there. SECURITY DEFINER so a caller's RLS on companies cannot make a company look absent.
CREATE OR REPLACE FUNCTION public.payroll_company_row_exists(p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company)
$$;
-- Owned by postgres (the tables' owner, BYPASSRLS), NOT migration_admin (breaker round 3 H of e61d6e877c): the owner may
-- CREATE OR REPLACE a function, and migration_admin, owning it, replaced it to answer false and reopened the pg_temp
-- delete. migration_admin is not a member of postgres, so it cannot. The owner of the tables could already disable the
-- triggers outright (stated; OWN, W7, moves ownership). Every other function this file creates is owned by the
-- migration role that runs it (postgres); the integration test pins all of them.
ALTER FUNCTION public.payroll_company_row_exists(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.payroll_company_row_exists(uuid) FROM PUBLIC;
-- Not app_user (breaker L of 5ef58a1b12: no app code needs it, and it would answer whether any company id exists).
-- app_user holds no DELETE on companies, so it never reaches a company cascade; a nested DELETE it fires another way
-- meets a permission error, which fails closed.
GRANT EXECUTE ON FUNCTION public.payroll_company_row_exists(uuid) TO platform_admin, migration_admin, postgres;
REVOKE EXECUTE ON FUNCTION public.payroll_company_row_exists(uuid) FROM app_user;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT 'payroll_company_row_exists(uuid)',
       'none: reads whether one companies row exists, by id, past RLS, for the 1054 header DELETE rule (a nested DELETE is exempt only once its company row is gone: the ON DELETE CASCADE of a company delete); answers a boolean, names nothing; EXECUTE to platform_admin, migration_admin and postgres only (not app_user)',
       public.app_definer_hash('public.payroll_company_row_exists(uuid)'::regprocedure)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- A company's id is fixed (breaker H of 5ef58a1b12): the helper above is only as good as companies.id. A role that may
-- UPDATE companies (platform_admin, migration_admin, postgres) swapped a victim company's id away for one statement,
-- deleted its final header from a pg_temp trigger (nested, and its company row "gone"), and swapped the id back before
-- the NO ACTION checks ran. No code changes a company's id (census in the PR body); a superuser is exempt as in 999n.
CREATE OR REPLACE FUNCTION public.companies_id_fixed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('is_superuser') <> 'on' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'companies: a company''s id is fixed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER companies_id_fixed
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_id_fixed();
ALTER TABLE public.companies ENABLE ALWAYS TRIGGER companies_id_fixed;

CREATE OR REPLACE FUNCTION public.payroll_run_headers_final_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN OLD;
  END IF;
  -- A company delete's cascade: nested, and its company row already gone. Any trigger added later that deletes
  -- headers is bound like a direct DELETE (breaker G3), so the census in the 1054 header stays true by construction.
  -- Nested IFs: SQL does not promise to evaluate AND left to right, and the helper is called only when nested.
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    IF NOT public.payroll_company_row_exists(OLD.company_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF COALESCE(OLD.status, '') IN ('approved', 'paid')
     AND COALESCE(OLD.approved_at, OLD.approval_grandfathered_at) IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_run_headers: a final pay run is not deleted (reopen or cancel it first)'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.company_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid
     AND (OLD.approval_evidence_at IS NOT NULL OR OLD.reopened_at IS NOT NULL
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

-- TRUNCATE fires no row trigger (breaker B2 of fb88f3fd9d): refuse it for every non-superuser, also when it arrives
-- through TRUNCATE companies CASCADE; and migration_admin, which held TRUNCATE without needing it, loses it.
CREATE OR REPLACE FUNCTION public.payroll_run_headers_no_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'payroll_run_headers: pay runs are not truncated' USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE TRIGGER payroll_run_headers_no_truncate
  BEFORE TRUNCATE ON public.payroll_run_headers
  FOR EACH STATEMENT EXECUTE FUNCTION public.payroll_run_headers_no_truncate();
ALTER TABLE public.payroll_run_headers ENABLE ALWAYS TRIGGER payroll_run_headers_no_truncate;
REVOKE TRUNCATE ON public.payroll_run_headers FROM migration_admin;

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
