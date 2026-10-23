-- Migration 915b: what the app's login roles (915) must never reach, as a
-- function the deploy re-checks.
--
-- Audit 2026-10-18 S-07b. Split out of 915 only to keep each file readable;
-- runs straight after it. scripts/check-app-login-roles.ts calls the function
-- from scripts/deploy.sh after every deploy's migrations, before the code
-- switch, in live mode once either login can log in.

-- Every way a login role's reach could reach the owner, one row each:
--   - a role either login can SET ROLE to (pg_has_role MEMBER is transitive and
--     ignores INHERIT) outside its allowlist;
--   - one in reach that is superuser, BYPASSRLS, CREATEROLE or REPLICATION;
--   - one in reach that owns anything, in ANY database of the cluster (prod and
--     dev share one): pg_shdepend records the owner of every table, function,
--     schema, type and database not owned by the bootstrap superuser;
--   - isaflow_app holding app_user's privileges without SET ROLE ('USAGE': on
--     PG 15 the member's INHERIT attribute decides it, on PG 16 the grant's own
--     INHERIT option, fixed when granted, so check the effect);
--   - any table, view or sequence granted to PUBLIC, which a login reaches
--     after RESET ROLE without being any of these roles.
--   - an app_service policy missing, extra, or applying to app_service in any
--     other shape (public.app_service_policy_drift(), 915).
-- With p_runtime_controls (once the logins can log in), also the runbook's
-- out-of-band controls: the DDL event trigger in this database, and both
-- logins in supautils.reserved_roles.
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
    RAISE EXCEPTION '915b: %', v;
  END LOOP;
END $$;
