-- 977: Tenant RLS on portal_access (an AR portal login).
--
-- Migration 937 gave portal_access a company_id (the company the login signs in
-- to) and left app_user SELECT on every column but password_hash, plus DELETE,
-- but never enabled row level security. Tenant isolation rested on each query's
-- own filter. This puts the table under FORCE RLS with the active-company
-- tenant_isolation policy every tenant table uses (897's form, as in 970):
-- the request's app.current_company_id(), and membership through
-- auth.user_companies() (request.jwt.claims).
--
-- Paths that read or write portal_access:
--   - portalService.ts login lookup and last-login stamp: migration_admin
--     (BYPASSRLS, 937), pre-tenant; unaffected.
--   - portalSession.ts resolvePortalSession: bare sql on the isaflow_service
--     pool, no tenant context. app_service_sync_policies() (915) below creates
--     app_service's select and delete mirrors, the same mirrors that already
--     serve the customers join in that query.
--   - customerMergeService.ts merge DELETE: a withAuth request as app_user with
--     the company set, deleting the source customer's own logins.
-- Grants are untouched (937's stay). No SECURITY DEFINER function is added.
--
-- A login whose company_id is NULL (937: its customer was gone) becomes
-- invisible to app_user; it already signed in nowhere.
--
-- Locks: ACCESS EXCLUSIVE on a small table, bounded by lock_timeout.
--
-- ROLLBACK. Takes portal_access back out of RLS, as before this migration.
-- Old code works with or without RLS, so there is no code-order constraint.
-- ROLLBACK SQL BEGIN
-- DROP POLICY IF EXISTS tenant_isolation ON public.portal_access;
-- ALTER TABLE public.portal_access NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.portal_access DISABLE ROW LEVEL SECURITY;
-- SELECT public.app_service_sync_policies();
-- ROLLBACK SQL END

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.portal_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_access FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.portal_access;
-- The active company AND membership (migration 897's form).
CREATE POLICY tenant_isolation ON public.portal_access
  FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- app_service's mirrors (select, delete: what app_user is granted). The
-- appliers also run this after every migration; run here so the pre-tenant
-- session check never sees the table without them.
SELECT public.app_service_sync_policies();

-- Exactly one policy besides app_service's mirrors, in this form: a second
-- permissive policy would be OR'd over it and undo the isolation.
DO $$
DECLARE
  v_ok pg_catalog.bool;
BEGIN
  SELECT c.relrowsecurity AND c.relforcerowsecurity
     AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = 'portal_access'
             AND p.policyname NOT LIKE 'app\_service\_%') = 1
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'portal_access'
                    AND p.policyname = 'tenant_isolation' AND p.cmd = 'ALL'
                    AND p.roles = ARRAY['app_user']::pg_catalog.name[]
                    AND p.qual LIKE '%app.current_company_id()%' AND p.qual LIKE '%auth.user_companies()%'
                    AND p.with_check LIKE '%app.current_company_id()%' AND p.with_check LIKE '%auth.user_companies()%')
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'portal_access'
                    AND p.policyname = 'app_service_select')
    INTO v_ok
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.portal_access'::pg_catalog.regclass;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 977: portal_access is not under FORCE RLS with exactly the active-company tenant_isolation policy and app_service''s select mirror';
  END IF;
END $$;
