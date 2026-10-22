-- Migration 911: the member guards bind app_service as they bind app_user.
--
-- Audit 2026-10-18 S-07b, after 910. company_users_role_guard and
-- company_invitations_role_guard (883, 886) apply their rules only when
-- current_user = 'app_user' and let every other role through. 910's
-- isaflow_service pool runs as itself (inheriting app_service, which inherits
-- app_user), so it was let through: with no claims at all it could add a
-- super_admin member, move a membership, remove a company's last owner, or
-- write an invitation at any role (S-07b breaker, F1), none of which
-- app_user can do even with forged claims. The DO block below rewrites only
-- that exemption line, in place, so it binds app_service-holding roles too.
--
-- The one service-pool path that wrote either table, POST /api/invite/[token],
-- now writes on the migration_admin pool, as /api/invitations/[token]/accept
-- already did.
--
-- Also, S-07b breaker round 2 (L1): three SECURITY DEFINER functions did not
-- put pg_temp last on their search_path, so a caller's temporary table could
-- shadow a table they read (no escalation was found: the shadow was refused).
-- pg_temp is pinned last on each, and the DO block below refuses any definer
-- function app_user can execute that leaves it out.
--
-- Also: app_user (and so both app pools) held INSERT/UPDATE/DELETE on
-- schema_migrations, through 348's default privileges. A deleted row
-- re-applies a migration on the next deploy; an inserted one skips it.
-- Nothing in the app writes it; the deploy's migration runner runs as the
-- owner. Revoked (S-07b breaker, F3).

-- Patch the exemption line in place, on whatever body each guard has now
-- (886's, or a later rewrite that sorts before this file, e.g. 908b), rather
-- than re-creating either function from an older text and dropping rules
-- added since. A guard that already binds app_service is left alone; any
-- other must contain the old line exactly once, or the migration stops.
DO $$
DECLARE
  v_fn pg_catalog.regprocedure;
  v_src pg_catalog.text;
  v_old CONSTANT pg_catalog.text := $o$IF current_user <> 'app_user' THEN$o$;
  v_new CONSTANT pg_catalog.text := $n$IF current_user <> 'app_user'
     AND NOT (pg_catalog.pg_has_role(current_user, 'app_service', 'USAGE')
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                              WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls))) THEN$n$;
  v_hits pg_catalog.int4;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.company_users_role_guard()'::pg_catalog.regprocedure,
                              'public.company_invitations_role_guard()'::pg_catalog.regprocedure] LOOP
    SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
    CONTINUE WHEN v_src ~ 'app_service';
    v_hits := (pg_catalog.length(v_src) - pg_catalog.length(pg_catalog.replace(v_src, v_old, ''))) / pg_catalog.length(v_old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '911: % holds the exemption line % time(s), expected exactly once; merge the app_service binding by hand', v_fn, v_hits;
    END IF;
    -- CREATE OR REPLACE keeps the owner, the grants and the triggers.
    EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(v_fn), v_old, v_new);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.company_users_role_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_invitations_role_guard() FROM PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.schema_migrations FROM app_user, PUBLIC;

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

-- Refuse the migration if any function in this database still exempts every
-- role but app_user, the shape that let isaflow_service through, or if a role
-- either app pool can reach may still write schema_migrations.
DO $$
DECLARE
  r record;
BEGIN
  -- Any spelling of "the caller is not app_user" that is not followed by the
  -- app_service clause (breaker round 2, L2).
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_catalog.pg_proc p
            WHERE p.prosrc ~* $re$(current_user|current_role|session_user|user)(\s*::\s*\w+)?\s*(<>|!=|is\s+distinct\s+from)\s*'app_user'(\s*::\s*\w+)?\s*(then|\))$re$ LOOP
    RAISE EXCEPTION '911: % exempts every role but app_user; app_service must take the same rules', r.f;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prosecdef AND n.nspname IN ('public', 'auth', 'app', 'platform_shared')
              AND pg_catalog.has_function_privilege('app_user', p.oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, '{}')) c
                               WHERE c ~ '^search_path=.*pg_temp"?$') LOOP
    RAISE EXCEPTION '911: definer function % runs for app_user without pg_temp last on its search_path', r.f;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles
            WHERE pg_catalog.pg_has_role('isaflow_app', oid, 'MEMBER')
               OR pg_catalog.pg_has_role('isaflow_service', oid, 'MEMBER') LOOP
    IF pg_catalog.has_table_privilege(r.rolname, 'public.schema_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '911: % (reachable from an app pool) can still write schema_migrations', r.rolname;
    END IF;
  END LOOP;
  -- The runner applying this file records it, and every later one, in
  -- schema_migrations: refuse the migration rather than a deploy whose own
  -- write was taken away with app_user's (blind review r2).
  IF NOT pg_catalog.has_table_privilege(current_user, 'public.schema_migrations', 'INSERT, UPDATE') THEN
    RAISE EXCEPTION '911: % (running this migration) could no longer record migrations', current_user;
  END IF;
END $$;
