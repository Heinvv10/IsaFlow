-- scripts/migrations/sql/351_rls_helpers_no_recursion.sql
-- Phase 2 follow-up: break RLS policy recursion on company_users.
--
-- Migration 348 installed policies whose USING clauses run SELECT against
-- company_users. When company_users ALSO has an RLS policy, the inner
-- SELECT triggers that policy, which runs ANOTHER SELECT against
-- company_users, which triggers the policy again. Postgres detects the
-- cycle and aborts with:
--     ERROR: infinite recursion detected in policy for relation "company_users"
--
-- Fix: wrap the membership lookup in SECURITY DEFINER functions. These run
-- as the function owner (postgres, superuser, BYPASSRLS), so the inner
-- SELECT skips RLS — no recursion. Policies then filter on the returned
-- UUID set, which is not a subquery against the protected table.

CREATE OR REPLACE FUNCTION auth.user_companies()
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT company_id FROM company_users WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION auth.user_admin_companies()
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT company_id FROM company_users
   WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
$$;

REVOKE ALL ON FUNCTION auth.user_companies() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.user_admin_companies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.user_companies() TO app_user, migration_admin;
GRANT EXECUTE ON FUNCTION auth.user_admin_companies() TO app_user, migration_admin;

-- Rewrite every tenant_isolation policy to use the helper (no recursion).
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'company_id'
      AND c.table_schema = 'public'
      AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('companies', 'company_users', 'company_invitations')
  LOOP
    EXECUTE format($p$
      DROP POLICY IF EXISTS tenant_isolation ON public.%1$I;
      CREATE POLICY tenant_isolation ON public.%1$I
        FOR ALL TO app_user
        USING (company_id IN (SELECT auth.user_companies()))
        WITH CHECK (company_id = app.current_company_id());
    $p$, t);
  END LOOP;
END $$;

-- Rewrite special-case policies too.
DROP POLICY IF EXISTS companies_member_read ON public.companies;
CREATE POLICY companies_member_read ON public.companies FOR SELECT TO app_user
  USING (id IN (SELECT auth.user_companies()));

DROP POLICY IF EXISTS companies_owner_write ON public.companies;
CREATE POLICY companies_owner_write ON public.companies FOR ALL TO app_user
  USING (id IN (SELECT auth.user_admin_companies()))
  WITH CHECK (id = app.current_company_id());

DROP POLICY IF EXISTS cu_self_or_admin ON public.company_users;
CREATE POLICY cu_self_or_admin ON public.company_users FOR ALL TO app_user
  USING (
    user_id = auth.uid()
    OR company_id IN (SELECT auth.user_admin_companies())
  )
  WITH CHECK (company_id = app.current_company_id());

DROP POLICY IF EXISTS invites_tenant ON public.company_invitations;
CREATE POLICY invites_tenant ON public.company_invitations FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

-- invites_by_token unchanged — no company_users reference.
