-- Migration 916: the member guards bind app_service as they bind app_user.
--
-- Audit 2026-10-18 S-07b, after 915. company_users_role_guard and
-- company_invitations_role_guard (883, 886, 908b) apply their rules only when
-- current_user = 'app_user' and let every other role through. 915's
-- isaflow_service pool runs as itself (inheriting app_service, which inherits
-- app_user), so it was let through: with no claims at all it could add a
-- super_admin member, move a membership, remove a company's last owner, or
-- write an invitation at any role (S-07b breaker, F1), none of which
-- app_user can do even with forged claims. The DO block below rewrites only
-- that exemption line, in place, so it binds app_service-holding roles too.
-- A superuser or BYPASSRLS role stays exempt even if it holds app_service
-- (pg_has_role is true for every superuser), as every role but app_user was.
--
-- The one service-pool path that wrote either table, POST /api/invite/[token],
-- now writes on the migration_admin pool, as /api/invitations/[token]/accept
-- already did.
--
-- 917 holds the rest of S-07b's hardening (schema_migrations, views,
-- definer search paths).

-- Patch the exemption line in place, on whatever body each guard has now
-- (886's, or a later rewrite that sorts before this file, e.g. 908b), rather
-- than re-creating either function from an older text and dropping rules
-- added since. A guard that already tests pg_has_role(current_user,
-- 'app_service', ...) is left alone; any other must contain the old line
-- exactly once, or the migration stops.
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
    CONTINUE WHEN v_src ~ $b$pg_has_role\(current_user,\s*'app_service'$b$;
    v_hits := (pg_catalog.length(v_src) - pg_catalog.length(pg_catalog.replace(v_src, v_old, ''))) / pg_catalog.length(v_old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '916: % holds the exemption line % time(s), expected exactly once; merge the app_service binding by hand', v_fn, v_hits;
    END IF;
    -- CREATE OR REPLACE keeps the owner, the grants and the triggers.
    EXECUTE pg_catalog.replace(pg_catalog.pg_get_functiondef(v_fn), v_old, v_new);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.company_users_role_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_invitations_role_guard() FROM PUBLIC;

-- Refuse the migration if any function in this database still exempts every
-- role but app_user, the shape that let isaflow_service through.
-- tests/unit/scripts/appUserExemptionSpelling.test.ts refuses the same shape
-- in any later migration file.
DO $$
DECLARE
  r record;
BEGIN
  -- Any spelling of "the caller is not app_user" that is not followed by the
  -- app_service clause (breaker round 2, L2).
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_catalog.pg_proc p
            WHERE p.prosrc ~* $re$(current_user|current_role|session_user|user)(\s*::\s*\w+)?\s*(<>|!=|is\s+distinct\s+from)\s*'app_user'(\s*::\s*\w+)?\s*(then|\))$re$
               OR p.prosrc ~* $re$'app_user'(\s*::\s*\w+)?\s*(<>|!=|is\s+distinct\s+from)\s*(current_user|current_role|session_user|user)(\s*::\s*\w+)?\s*(then|\))$re$ LOOP
    RAISE EXCEPTION '916: % exempts every role but app_user; app_service must take the same rules', r.f;
  END LOOP;
END $$;
