-- scripts/rollback/phase2-disable-rls.sql
-- Disables RLS and drops Phase 2 helpers. Use only if Phase 2 ships broken
-- and we need to restore the pre-Phase-2 codebase paired with a non-RLS DB.

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'company_id' AND c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS companies_member_read ON public.companies;
DROP POLICY IF EXISTS companies_owner_write ON public.companies;
ALTER TABLE public.companies DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cu_self_or_admin ON public.company_users;
ALTER TABLE public.company_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_users NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invites_tenant ON public.company_invitations;
DROP POLICY IF EXISTS invites_by_token ON public.company_invitations;
ALTER TABLE public.company_invitations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_invitations NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self_read ON public.users;
DROP POLICY IF EXISTS users_self_write ON public.users;
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS auth.uid();
DROP FUNCTION IF EXISTS app.current_company_id();

-- Added in migration 351 (SECURITY DEFINER helpers to break recursion).
DROP FUNCTION IF EXISTS auth.user_companies();
DROP FUNCTION IF EXISTS auth.user_admin_companies();

-- Keep the roles; they're harmless if unused. Keep schemas.
-- DO NOT restore users.password_hash etc. — that requires a fresh backup restore.
