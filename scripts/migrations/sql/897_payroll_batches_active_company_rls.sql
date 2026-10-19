-- 897: payroll_batches is scoped to the ACTIVE company, not to every company the caller belongs to.
--
--   497's header calls payroll_batches "NOT itself under RLS". That was true when 497 was written and stopped
--   being true one migration later: 498's catalogue sweep found it (company_id, no policy) and gave it ENABLE +
--   FORCE + a tenant_isolation policy whose USING and WITH CHECK are both plain membership:
--     company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid())
--   So a user who belongs to two companies, working in A (app.current_company_id = A), could through app_user
--   still read, update and delete B's batches, insert a batch into B, and UPDATE … SET company_id = B to move one
--   of A's batches into B. The service always filters by company_id, so nothing reachable does that today; this
--   is the database barrier underneath it. 498 used membership-only on purpose for tables some withAuth path
--   writes for a non-active company. payroll_batches has no such path (see "Writers and readers" below).
--
--   Policy below: a row is visible and writable only when it belongs to the active company AND the caller is a
--   member of it. Both halves, so a forged or stale company GUC alone is not enough (497 already requires both on
--   payroll_batch_lines' WITH CHECK; 699 does the same for practice_client_rate_overrides). Membership goes
--   through auth.user_companies() (351, SECURITY DEFINER) rather than an inline company_users sub-select.
--   payroll_batch_lines' policy (497) joins this table, so its reads narrow to the active company the same way.
--
--   Writers and readers: src/modules/accounting/services/payroll/payrollBatchService.ts only, called from
--   pages/api/payroll/batches/{index,[id]/index,[id]/lines,[id]/validate,[id]/post}.ts. Every one is wrapped in
--   withAuth and passes req.companyId, which is the activeCompanyId withAuth writes into app.current_company_id
--   after its membership check. No cron, portal, bureau, MCP or extension path touches the table. The pool role
--   (BYPASSRLS), the migration runner and FK cascades from companies are unaffected.
--
-- Rollback (restores 498's form exactly):
--   DROP POLICY IF EXISTS tenant_isolation ON public.payroll_batches;
--   CREATE POLICY tenant_isolation ON public.payroll_batches FOR ALL TO app_user
--     USING (company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid()))
--     WITH CHECK (company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid()));
--   ENABLE / FORCE stay: 498 set both, and rolling back must not drop the table out of RLS.
-- Locks: DROP / CREATE POLICY take ACCESS EXCLUSIVE on payroll_batches for a catalogue-only change.

ALTER TABLE public.payroll_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.payroll_batches;
CREATE POLICY tenant_isolation ON public.payroll_batches
  FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- Exactly one policy, in this form: a second permissive policy would be OR'd over it and undo the narrowing.
DO $$
DECLARE
  v_ok pg_catalog.bool;
BEGIN
  SELECT c.relrowsecurity AND c.relforcerowsecurity
     AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = 'payroll_batches') = 1
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'payroll_batches'
                    AND p.policyname = 'tenant_isolation' AND p.cmd = 'ALL'
                    AND p.roles = ARRAY['app_user']::pg_catalog.name[]
                    AND p.qual LIKE '%app.current_company_id()%' AND p.qual LIKE '%auth.user_companies()%'
                    AND p.with_check LIKE '%app.current_company_id()%' AND p.with_check LIKE '%auth.user_companies()%')
    INTO v_ok
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.payroll_batches'::pg_catalog.regclass;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 897: payroll_batches is not under FORCE RLS with exactly the active-company tenant_isolation policy';
  END IF;
END $$;
