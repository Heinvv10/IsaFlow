-- Migration 920: two S-07b follow-up rules, checked on every deploy.
--
-- 918 took users.email away from app_service and 919 took the AR view
-- summary's materialized view away from app_user. A one-off guard in each
-- would hold only on the day it applied: 348's ALTER DEFAULT PRIVILEGES gives
-- app_user SELECT on every table a later migration creates, materialized views
-- included, so the next one would be cross-tenant by default; and a later
-- GRANT could hand email back. So both rules are a function, which this
-- migration and scripts/check-app-login-roles.ts (deploy.sh, after every
-- deploy's migrations, before the code switch) run:
--   - no role either app login reaches (itself, app_user, app_service, any
--     role it can SET ROLE to; PUBLIC's grants count) may INSERT or UPDATE
--     users.email, or touch auth_email_verification_tokens, whose payload
--     email verify-email writes into users.email (918);
--   - none may read any column of a materialized view in public, auth, app or
--     platform_shared: none has RLS. A materialized view the app needs is read
--     through a company-filtered definer, as 919 does.
-- has_column_privilege / has_any_column_privilege count table-level grants,
-- column grants, PUBLIC, other grantors and inherited roles.

CREATE OR REPLACE FUNCTION public.app_pool_reach_violations()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH reach AS (
    SELECT r.oid, r.rolname FROM pg_catalog.pg_roles r
     WHERE (pg_catalog.to_regrole('isaflow_app') IS NOT NULL AND pg_catalog.pg_has_role('isaflow_app', r.oid, 'MEMBER'))
        OR (pg_catalog.to_regrole('isaflow_service') IS NOT NULL AND pg_catalog.pg_has_role('isaflow_service', r.oid, 'MEMBER'))
  )
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s users.email', reach.rolname, p.priv)
    FROM reach CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) p(priv)
   WHERE pg_catalog.has_column_privilege(reach.oid, 'public.users', 'email', p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s auth_email_verification_tokens', reach.rolname, p.priv)
    FROM reach CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
   WHERE pg_catalog.has_table_privilege(reach.oid, pg_catalog.to_regclass('public.auth_email_verification_tokens'), p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can SELECT the materialized view %s', reach.rolname, c.oid::regclass)
    FROM reach
   CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'm' AND n.nspname IN ('public', 'auth', 'app', 'platform_shared')
     AND pg_catalog.has_any_column_privilege(reach.oid, c.oid, 'SELECT')
$$;
REVOKE ALL ON FUNCTION public.app_pool_reach_violations() FROM PUBLIC;

DO $$
DECLARE
  v text;
BEGIN
  FOR v IN SELECT * FROM public.app_pool_reach_violations() ORDER BY 1 LOOP
    RAISE EXCEPTION '920: %', v;
  END LOOP;
END $$;
