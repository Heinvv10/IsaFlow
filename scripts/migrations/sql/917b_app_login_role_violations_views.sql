-- Migration 917b: app_login_role_violations() also refuses an owner-run view
-- app_user may use, so the check 917 ran once runs on every deploy.
--
-- Audit 2026-10-18 S-07b, blind review of 916b (2026-10-23). 348's default
-- privileges grant app_user SELECT/INSERT/UPDATE/DELETE on every table and view
-- the role that ran it (postgres on production) creates later. A migration that
-- adds a view without security_invoker, run as postgres, hands app_user a view
-- that reads every tenant's rows; 917's guard ran once and would not see it.
-- scripts/deploy.sh runs scripts/check-app-login-roles.ts after the
-- migrations and before the code switch, so such a view now stops the deploy.
-- The function is 915b's, unchanged apart from the view loop.

CREATE OR REPLACE FUNCTION public.app_login_role_violations(p_runtime_controls boolean DEFAULT false)
RETURNS SETOF text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  login text;
  allowed text[];
  r record;
  reserved text[];
BEGIN
  FOR login, allowed IN VALUES
    ('isaflow_app',     ARRAY['isaflow_app', 'app_user']),
    ('isaflow_service', ARRAY['isaflow_service', 'app_service', 'app_user'])
  LOOP
    FOR r IN SELECT oid, rolname, rolsuper, rolbypassrls, rolcreaterole, rolreplication
               FROM pg_roles WHERE pg_has_role(login, oid, 'MEMBER') LOOP
      IF NOT r.rolname = ANY (allowed) THEN
        RETURN NEXT format('%s can reach role %s, outside its allowlist %s', login, r.rolname, allowed);
      END IF;
      IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolreplication THEN
        RETURN NEXT format('%s can reach %s, which is superuser, BYPASSRLS, CREATEROLE or REPLICATION', login, r.rolname);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
                    AND refobjid = r.oid AND deptype = 'o') THEN
        RETURN NEXT format('%s can reach %s, which owns objects in this cluster', login, r.rolname);
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT rolinherit FROM pg_roles WHERE rolname = 'isaflow_app')
     OR pg_has_role('isaflow_app', 'app_user', 'USAGE') THEN
    RETURN NEXT 'isaflow_app must be NOINHERIT and must not inherit app_user';
  END IF;
  FOR r IN SELECT d.why, d.tbl, d.what FROM public.app_service_policy_drift() d LOOP
    IF r.why = 'foreign' THEN
      RETURN NEXT format('policy %s on %s applies to app_service but is not one of its mirrors; remove it', r.what, r.tbl);
    ELSE
      RETURN NEXT format('app_service policy %s on %s is %s (run SELECT public.app_service_sync_policies())', r.what, r.tbl, r.why);
    END IF;
  END LOOP;
  -- 917's view check, on every deploy: a view runs as its owner unless
  -- security_invoker is set, and an RLS-bypassing owner turns any view app_user
  -- may use into a cross-tenant table. 348's default privileges grant app_user
  -- every new table and view postgres creates, so a later migration can bring
  -- the shape back (917b).
  FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c
             JOIN pg_namespace ns ON ns.oid = c.relnamespace
             JOIN pg_roles o ON o.oid = c.relowner
            WHERE c.relkind = 'v' AND ns.nspname IN ('public', 'auth', 'app', 'platform_shared')
              AND (o.rolsuper OR o.rolbypassrls)
              AND has_table_privilege('app_user', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
              AND NOT coalesce(c.reloptions && ARRAY['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false) LOOP
    RETURN NEXT format('view %s runs as an RLS-bypassing owner and app_user may use it; set security_invoker or revoke app_user', r.rel);
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel, a.privilege_type
             FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace,
                  aclexplode(c.relacl) a
            WHERE a.grantee = 0 AND ns.nspname NOT IN ('pg_catalog', 'information_schema') LOOP
    RETURN NEXT format('%s grants %s to PUBLIC, which every login holds after RESET ROLE', r.rel, r.privilege_type);
  END LOOP;
  IF p_runtime_controls THEN
    -- Fires always ('O' origin, 'A' always; not 'R' replica-only or 'D'), on
    -- every tag, and runs the runbook's function.
    IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'refuse_app_pool_ddl'
                     AND evtevent = 'ddl_command_start' AND evtenabled IN ('O', 'A') AND evttags IS NULL
                     AND evtfoid = to_regprocedure('public.refuse_app_pool_ddl()')) THEN
      RETURN NEXT 'event trigger refuse_app_pool_ddl is missing, disabled or not as the runbook creates it, in this database (runbook step 2)';
    END IF;
    reserved := regexp_split_to_array(coalesce(current_setting('supautils.reserved_roles', true), ''), '\s*,\s*');
    FOREACH login IN ARRAY ARRAY['isaflow_app', 'isaflow_service'] LOOP
      IF NOT login = ANY (reserved) THEN
        RETURN NEXT format('%s is not in supautils.reserved_roles (runbook step 3b)', login);
      END IF;
    END LOOP;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.app_login_role_violations(boolean) FROM PUBLIC;

DO $$
DECLARE
  v text;
BEGIN
  FOR v IN SELECT public.app_login_role_violations(false) LOOP
    RAISE EXCEPTION '917b: %', v;
  END LOOP;
END $$;
