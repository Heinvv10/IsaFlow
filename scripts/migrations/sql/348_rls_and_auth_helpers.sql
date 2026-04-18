-- scripts/migrations/sql/348_rls_and_auth_helpers.sql
-- Phase 2: RLS + JWT-claim GUC helpers. See spec 2026-04-18.

-- ───────────────────────────────────────────── Roles ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- So the pool connection (as postgres) can SET LOCAL ROLE app_user
GRANT app_user TO postgres;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migration_admin') THEN
    -- Password must be set by ops via the secrets store; placeholder password
    -- is rotated immediately after migration. See Task 5.1.
    CREATE ROLE migration_admin WITH LOGIN BYPASSRLS PASSWORD 'CHANGEME_SET_VIA_OPS';
  END IF;
END $$;

GRANT ALL PRIVILEGES ON SCHEMA public TO migration_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO migration_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO migration_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO migration_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO migration_admin;

-- ─────────────────────────────────── Helper schemas ──────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;

GRANT USAGE ON SCHEMA auth TO app_user, migration_admin;
GRANT USAGE ON SCHEMA app TO app_user, migration_admin;

-- auth.uid() reads the 'sub' claim from the JWT stashed in request.jwt.claims
-- Returns text because IsaFlow's users.id + company_users.user_id are text,
-- not uuid (text is gen_random_uuid()::text; we didn't migrate the column
-- types because of extensive FK references).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'
$$;

CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_company_id', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION auth.uid() TO app_user, migration_admin;
GRANT EXECUTE ON FUNCTION app.current_company_id() TO app_user, migration_admin;

-- ────────────────────── RLS on every public.* company_id table ──────────────
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'company_id'
      AND c.table_schema = 'public'
      AND tb.table_type = 'BASE TABLE'
      -- companies uses `id`, not `company_id`. company_users and
      -- company_invitations have special-case policies below; leaving
      -- tenant_isolation on them would OR with the special-case policy
      -- (RLS is PERMISSIVE by default) and over-grant access.
      AND c.table_name NOT IN ('companies', 'company_users', 'company_invitations')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS tenant_isolation ON public.%1$I;
      CREATE POLICY tenant_isolation ON public.%1$I
        FOR ALL TO app_user
        USING (company_id IN (
          SELECT company_id FROM public.company_users
           WHERE user_id = auth.uid()
        ))
        WITH CHECK (company_id = app.current_company_id());
    $p$, t);
  END LOOP;
END $$;

-- ──────────────────────────── Special-case: companies ───────────────────────
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS companies_member_read ON public.companies;
CREATE POLICY companies_member_read ON public.companies FOR SELECT TO app_user
  USING (id IN (
    SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS companies_owner_write ON public.companies;
CREATE POLICY companies_owner_write ON public.companies FOR ALL TO app_user
  USING (id IN (
    SELECT company_id FROM public.company_users
     WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ))
  WITH CHECK (id = app.current_company_id());

-- ──────────────────────── Special-case: company_users ───────────────────────
ALTER TABLE public.company_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_users FORCE ROW LEVEL SECURITY;

-- Cleanup: earlier plan revisions allowed tenant_isolation to be applied to
-- company_users via the DO-block. Drop any stale policy before installing
-- the admin-gated one below.
DROP POLICY IF EXISTS tenant_isolation ON public.company_users;

DROP POLICY IF EXISTS cu_self_or_admin ON public.company_users;
CREATE POLICY cu_self_or_admin ON public.company_users FOR ALL TO app_user
  USING (
    user_id = auth.uid()
    OR company_id IN (
      SELECT company_id FROM public.company_users
       WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  )
  WITH CHECK (company_id = app.current_company_id());

-- ─────────── Special-case: company_invitations (anonymous token accept) ─────
ALTER TABLE public.company_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_invitations FORCE ROW LEVEL SECURITY;

-- Same cleanup as above — earlier DO-block revisions over-applied.
DROP POLICY IF EXISTS tenant_isolation ON public.company_invitations;

DROP POLICY IF EXISTS invites_tenant ON public.company_invitations;
CREATE POLICY invites_tenant ON public.company_invitations FOR ALL TO app_user
  USING (company_id IN (
    SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
  ))
  WITH CHECK (company_id = app.current_company_id());

-- Additional policy: anonymous accept-invite flow sets app.invite_token GUC.
-- Only SELECT is allowed via this path; the accept endpoint uses a
-- BYPASSRLS migration_admin connection for the subsequent INSERT into
-- company_users.
DROP POLICY IF EXISTS invites_by_token ON public.company_invitations;
CREATE POLICY invites_by_token ON public.company_invitations FOR SELECT TO app_user
  USING (
    token = nullif(current_setting('app.invite_token', true), '')
    AND accepted_at IS NULL
    AND expires_at > now()
  );

-- ─────────────── `users` shadow table: users see only themselves ────────────
-- (Profile-shadow; not company-scoped. Phase 2 trims this table in mig 349.)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self_read ON public.users;
CREATE POLICY users_self_read ON public.users FOR SELECT TO app_user
  USING (id = auth.uid());

DROP POLICY IF EXISTS users_self_write ON public.users;
CREATE POLICY users_self_write ON public.users FOR UPDATE TO app_user
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
