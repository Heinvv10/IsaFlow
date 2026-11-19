-- 1011: row security on payroll_run_lines (wave 6 RLS-L; found by the FZ #1567 breaker).
--
-- payroll_run_lines (382) never had row security: no ENABLE, no FORCE, no policy. Its parent payroll_run_headers
-- has had tenant_isolation since 348/498, but a request that read or wrote lines WITHOUT joining the header (by
-- run_id alone, or by guessing a line id) reached every tenant's pay figures: net pay, PAYE, the explanation and
-- the payslip snapshot. This puts the table under ENABLE + FORCE with one app_user policy.
--
-- TENANT THROUGH THE PARENT, NOT A NEW company_id COLUMN. The table has no company_id. run_id is NOT NULL, an FK to
-- payroll_run_headers ON DELETE CASCADE, so the header is already the one source of a line's tenant. The policy reads
-- it, exactly as 497 does for payroll_batch_lines and bank_transaction_attachments (tenant_isolation_via_parent).
-- Adding and backfilling a company_id was rejected:
--   * the backfill is an UPDATE of every line, including the lines of final runs, which 999n's freeze trigger refuses
--     to every non-superuser (production's deploy role is NOSUPERUSER), so it could not apply on production;
--   * old colour inserts would not set it (a fill trigger, a NOT NULL via NOT VALID + VALIDATE, and a trigger keeping
--     it equal to the header's company would all be needed), and a copy of the header's company can drift from it;
--   * the parent read is an index probe on payroll_run_headers' primary key per run, not per line (see the plan
--     check in tests/integration/payroll-run-lines-rls.int.test.ts).
--
-- THE POLICY (app_user only, FOR ALL; same shape as payroll_batch_lines in 497):
--   USING       the line's header belongs to a company the session's user is a member of (company_users of
--               auth.uid()): the same rows payroll_run_headers' tenant_isolation admits, so a read that already
--               joins the header sees exactly what it saw before;
--   WITH CHECK  that, AND the header is the ACTIVE company's (app.current_company_id()), as the header's own WITH
--               CHECK requires: no line is written into, or moved onto, another tenant's run.
-- Who is affected (census in the PR body): only sessions in role app_user. Every app_user entry point (withAuth,
-- bearerPipeline / MCP, companyOwnTx, auditTx, budgetRollJob, sarsEfilingRepo) sets a member user's claims and the
-- active company. The service pool (isaflow_service: app_service) gets USING (true) mirrors from
-- app_service_sync_policies(), called below in this transaction, so the employee portal and any service-pool read
-- never sees a window with RLS on and no mirror. postgres, migration_admin and platform_admin bypass RLS.
-- The 999n freeze trigger (payroll_run_lines_final_frozen) is unchanged: it judges finality through its reviewed
-- DEFINER payroll_run_final_state(uuid), which already reads the header past RLS. No DEFINER is created or changed
-- here, so no app_definer_reviews (930) row.
--
-- Old colour (the release before this one, running against this schema): every app_user read of payroll_run_lines
-- in that code is either joined to payroll_run_headers (already filtered by the identical membership predicate) or
-- keyed by a run_id its service has just checked belongs to the request's company; every write (replaceRunLines,
-- freezePayslipDetails, clearPayslipDetails) runs under withAuth/bearer on a run of the active company. So it sees
-- and writes the same rows as before. Expand-only: no column, constraint or index changes.
--
-- Idempotent and non-superuser: ALTER TABLE ... ENABLE/FORCE repeat harmlessly; the policy is dropped and recreated;
-- the table owner (postgres) runs it.
--
-- Rollback (down SQL; code needs no rollback, it never depended on the table being open):
--   DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.payroll_run_lines;
--   ALTER TABLE public.payroll_run_lines NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE public.payroll_run_lines DISABLE ROW LEVEL SECURITY;
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payroll_run_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_run_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.payroll_run_lines;
CREATE POLICY tenant_isolation_via_parent ON public.payroll_run_lines
  FOR ALL TO app_user
  USING (EXISTS (
    SELECT 1 FROM public.payroll_run_headers h
     WHERE h.id = payroll_run_lines.run_id
       AND h.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.payroll_run_headers h
     WHERE h.id = payroll_run_lines.run_id
       AND h.company_id = app.current_company_id()
       AND h.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())
  ));

SELECT public.app_service_sync_policies();

-- The policy above is the only limit for app_user and PUBLIC: refuse to finish if any other policy for them exists
-- (a stray permissive USING (true) would OR away the tenant check).
DO $$
DECLARE
  v_stray text;
BEGIN
  SELECT string_agg(p.policyname, ', ') INTO v_stray
    FROM pg_catalog.pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'payroll_run_lines'
     AND p.policyname <> 'tenant_isolation_via_parent'
     AND (p.roles && ARRAY['app_user', 'public']::name[]);
  IF v_stray IS NOT NULL THEN
    RAISE EXCEPTION '1011: payroll_run_lines has app_user/PUBLIC policies besides tenant_isolation_via_parent: %', v_stray;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = 'public.payroll_run_lines'::regclass
                  AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '1011: payroll_run_lines is not under ENABLE + FORCE row level security';
  END IF;
END
$$;
