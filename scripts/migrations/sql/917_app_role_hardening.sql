-- Migration 917: S-07b hardening that follows from the app's own logins.
--
-- Audit 2026-10-18 S-07b, after 915 and 916. Three separate fixes, each with
-- its own refusal in the DO block at the end:
--
-- schema_migrations: app_user (and so both app pools) held INSERT/UPDATE/DELETE
-- on it, through 348's default privileges. A deleted row re-applies a
-- migration on the next deploy; an inserted one skips it. Nothing in the app
-- writes it; the deploy's migration runner runs as the owner. Revoked (S-07b
-- breaker, F3).
--
-- Views: clients and app_settings, owned by postgres, ran as their owner for
-- app_user (S-07b verifier, P1, see below); a view in that shape is refused
-- from now on.
--
-- Definer search paths: three SECURITY DEFINER functions did not put pg_temp
-- last, so a caller's temporary table could shadow a table they read (S-07b
-- breaker round 2, L1; no escalation was found: the shadow was refused).
-- pg_temp is pinned last on each, and any definer function app_user can
-- execute that leaves it out is refused.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.schema_migrations FROM app_user, PUBLIC;

-- clients (over customers) and app_settings (over accounting_settings) are
-- owned by postgres, which bypasses RLS, and ran as their owner: app_user,
-- which holds SELECT/INSERT/UPDATE/DELETE on both, read and wrote every
-- tenant's rows through them (S-07b verifier, P1). security_invoker makes
-- each run with the caller's privileges and RLS. Every caller in the code
-- either filters by company or joins the invoice's own client, so each sees
-- the rows it saw before for its own company. Settings rows with no company
-- would vanish behind RLS for app_user: refuse rather than guess.
DO $$
BEGIN
  IF pg_catalog.to_regclass('public.accounting_settings') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.accounting_settings WHERE company_id IS NULL) THEN
    RAISE EXCEPTION '917: accounting_settings holds rows with no company_id; under security_invoker app_settings would hide them from every request. Assign or remove them first.';
  END IF;
  IF pg_catalog.to_regclass('public.clients') IS NOT NULL THEN
    ALTER VIEW public.clients SET (security_invoker = true);
  END IF;
  IF pg_catalog.to_regclass('public.app_settings') IS NOT NULL THEN
    ALTER VIEW public.app_settings SET (security_invoker = true);
  END IF;
END $$;

-- Each only where it exists: the user_admin_companies(text) overload is in
-- dev's schema but no migration creates it (blind review r3). The DO block at
-- the end still refuses any app_user-executable definer left without pg_temp.
DO $$
DECLARE
  v pg_catalog.text[];
BEGIN
  FOREACH v SLICE 1 IN ARRAY ARRAY[
    ARRAY['auth.user_admin_companies(text)', 'public, pg_temp'],
    ARRAY['auth.set_default_company(uuid, uuid)', 'public, auth, pg_temp'],
    ARRAY['public.invite_token_company_name()', 'pg_catalog, public, pg_temp']] LOOP
    IF pg_catalog.to_regprocedure(v[1]) IS NOT NULL THEN
      EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = %s', pg_catalog.to_regprocedure(v[1]), v[2]);
    END IF;
  END LOOP;
END $$;

-- Refuse the migration if a definer app_user can run lacks pg_temp last, a
-- view runs as an RLS-bypassing owner for app_user, a role either app pool can
-- reach may still write schema_migrations, or the runner itself can no longer
-- record migrations.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prosecdef AND n.nspname IN ('public', 'auth', 'app', 'platform_shared')
              AND pg_catalog.has_function_privilege('app_user', p.oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, '{}')) c
                               WHERE c ~ '^search_path=.*pg_temp"?$') LOOP
    RAISE EXCEPTION '917: definer function % runs for app_user without pg_temp last on its search_path', r.f;
  END LOOP;
  -- A view runs as its owner unless security_invoker is set; an owner that
  -- bypasses RLS turns any view app_user may use into a cross-tenant table.
  FOR r IN SELECT c.oid::regclass AS v FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
            WHERE c.relkind = 'v' AND n.nspname IN ('public', 'auth', 'app', 'platform_shared')
              AND (o.rolsuper OR o.rolbypassrls)
              AND pg_catalog.has_table_privilege('app_user', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
              AND NOT COALESCE(c.reloptions && ARRAY['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false) LOOP
    RAISE EXCEPTION '917: view % runs as an RLS-bypassing owner and app_user may use it; set security_invoker', r.v;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles
            WHERE pg_catalog.pg_has_role('isaflow_app', oid, 'MEMBER')
               OR pg_catalog.pg_has_role('isaflow_service', oid, 'MEMBER') LOOP
    IF pg_catalog.has_table_privilege(r.rolname, 'public.schema_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '917: % (reachable from an app pool) can still write schema_migrations', r.rolname;
    END IF;
  END LOOP;
  -- The runner applying this file records it, and every later one, in
  -- schema_migrations: refuse the migration rather than a deploy whose own
  -- write was taken away with app_user's (blind review r2).
  -- has_table_privilege with a list is true when ANY one is held; it needs both.
  IF NOT pg_catalog.has_table_privilege(current_user, 'public.schema_migrations', 'INSERT')
     OR NOT pg_catalog.has_table_privilege(current_user, 'public.schema_migrations', 'UPDATE') THEN
    RAISE EXCEPTION '917: % (running this migration) could no longer record migrations', current_user;
  END IF;
END $$;
