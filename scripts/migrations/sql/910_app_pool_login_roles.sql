-- Migration 910: the app's pools log in as roles that cannot become the owner.
--
-- Audit 2026-10-18 S-07b. Every pool built from DATABASE_URL logged in as
-- `postgres`, which owns nearly every table in public and has BYPASSRLS.
-- withAuth runs `SET LOCAL ROLE app_user`, but injected SQL can call
-- set_config('role', 'none', true) (or RESET ROLE) and land back on the
-- session user: one statement then reads any table as the owner, and the next
-- writes as the owner (users.role = 'super_admin', DDL, switching off the
-- forensic triggers). 902's column privileges bind app_user only.
--
-- This migration creates two login roles and one group role. It sets no
-- password and does not let either role log in: the ops step (runbook in the
-- S-07b handoff) runs ALTER ROLE ... LOGIN PASSWORD out of band, then points
-- the app's env at them. Until then nothing uses them.
--
--   isaflow_app      DATABASE_URL. Every request transaction: withAuth,
--                    bearer/MCP, extension tokens, invite tokens and
--                    withPlatformAdmin's membership gate. Each issues
--                    SET LOCAL ROLE app_user as its first statement after
--                    BEGIN. NOINHERIT and a member of app_user only, so
--                    RESET ROLE / set_config('role','none') lands on a role
--                    that holds nothing.
--   isaflow_service  SERVICE_DATABASE_URL. The `sql` fallback pool and the
--                    rate-limit pool: every path with no request transaction
--                    (crons, after-commit work, public webhooks, login /
--                    reset / verify / OAuth token, PAT lookups, withUserAuth
--                    routes). Inherits app_service.
--   app_service      NOLOGIN group. Inherits app_user's grants (and so every
--                    future table's, through 348's default privileges), and
--                    gets, per table, a policy that admits every row for each
--                    command an app_user policy admits. That is exactly what
--                    app_user reaches when injected SQL forges
--                    request.jwt.claims / app.current_company_id, which every
--                    app_user policy reads; a command no app_user policy
--                    grants (e.g. writes to the audit snapshot tables, or
--                    flow_bundles, whose write policy is `false`) stays
--                    closed. Extras beyond app_user, each named below with
--                    its caller: users.email + updated_at, the email
--                    verification tokens table, and EXECUTE on a definer
--                    wrapper for the one REFRESH MATERIALIZED VIEW.
--
-- Neither login role can reach a superuser, a BYPASSRLS role, or any role
-- that owns an object in this database; isaflow_app cannot reach
-- app_service. The DO block at the end refuses the migration otherwise.
--
-- RESIDUAL, DELIBERATE: injected SQL on an isaflow_service path can write any
-- user's email (change-email and the POPIA erasure need that column, and run
-- with no tenant). 902 still holds for app_user, i.e. for every authenticated
-- route. Triggers that judge current_user = 'app_user' must judge app_service
-- too: 911 does that for the member guards and refuses any function left in
-- the old shape.
--
-- Roles are cluster-wide and prod and dev share a cluster (PG 15), so the
-- first database this runs on creates them for every database; each step is
-- idempotent and safe to re-run. Runs as the deploy's `postgres`
-- (NOSUPERUSER, CREATEROLE), which on PG 15 may create roles and grant
-- membership in any non-superuser role. The PG 16 integration fixture gives
-- it ADMIN OPTION on app_user to match (scripts/ci/integration/pg-cluster.sh).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_service') THEN
    CREATE ROLE app_service NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'isaflow_app') THEN
    CREATE ROLE isaflow_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'isaflow_service') THEN
    CREATE ROLE isaflow_service NOLOGIN;
  END IF;
END $$;

-- CREATE ROLE's defaults are NOSUPERUSER NOBYPASSRLS NOREPLICATION. A
-- non-superuser may not name those three in ALTER ROLE at all, even to turn
-- them off, so the guard below asserts them instead. LOGIN is left alone:
-- after the ops step enables it, a re-run must not undo it.
--
-- Each ALTER and GRANT runs only when the role is not already so: once the
-- runbook adds the two logins to supautils.reserved_roles (only a superuser
-- may then modify them), a re-run on another database of the cluster must
-- not touch them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('app_service', true, false), ('isaflow_app', false, NULL::bool),
                                 ('isaflow_service', true, NULL::bool)) v(name, inherit, login) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name
                 AND (rolcreatedb OR rolcreaterole OR rolinherit IS DISTINCT FROM r.inherit
                      OR (r.login IS NOT NULL AND rolcanlogin IS DISTINCT FROM r.login))) THEN
      EXECUTE format('ALTER ROLE %I NOCREATEDB NOCREATEROLE %s%s', r.name,
                     CASE WHEN r.inherit THEN 'INHERIT' ELSE 'NOINHERIT' END,
                     CASE WHEN r.login IS FALSE THEN ' NOLOGIN' ELSE '' END);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES ('app_user', 'app_service'), ('app_user', 'isaflow_app'),
                                 ('app_service', 'isaflow_service')) v(grp, member) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.grp::regrole AND m.member = r.member::regrole) THEN
      EXECUTE format('GRANT %I TO %I', r.grp, r.member);
    END IF;
  END LOOP;
END $$;

-- change-email.ts and the data-subject-rights erasure write email; both stamp
-- updated_at. 902 withholds both from app_user.
GRANT UPDATE (email, updated_at) ON public.users TO app_service;

-- emailVerificationService (register, verify-email, resend) runs on the
-- service pool; app_user was never granted this table.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_email_verification_tokens TO app_service;

-- REFRESH MATERIALIZED VIEW needs the view's owner. The cron calls this
-- instead; it takes no input and refreshes one fixed view.
CREATE OR REPLACE FUNCTION public.refresh_customer_invoice_view_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.customer_invoice_view_summary;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_customer_invoice_view_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_customer_invoice_view_summary() TO app_service;

-- One permissive policy per (table, command) that some app_user or PUBLIC
-- policy admits, and only where app_user holds the command's privilege (a
-- policy on a table app_user cannot touch would only widen app_service's reach
-- if a grant arrived later; column privileges count, 902 leaves app_user only
-- column UPDATE on users). Excluded: impersonation_sessions, which app_user
-- reads only by its own session id and no service path reads at all.
--
-- What a policy admits, per command, judged as Postgres judges it: SELECT and
-- DELETE by USING, INSERT by WITH CHECK, UPDATE by both, and an absent WITH
-- CHECK falls back to USING. A policy whose USING or WITH CHECK is the
-- constant `false` admits nothing for the commands that read it, so a FOR ALL
-- policy contributes only the commands its predicates leave open. Policies
-- named app_service_<cmd> are owned by this migration; re-runs skip them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH pol AS (
      SELECT p.polrelid, p.polcmd,
             coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'false' AS using_false,
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), pg_get_expr(p.polqual, p.polrelid), 'true') = 'false' AS check_false
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname <> 'impersonation_sessions'
         AND p.polpermissive
         AND p.polname NOT LIKE 'app\_service\_%'
         AND (p.polroles = '{0}'::oid[] OR 'app_user'::regrole = ANY (p.polroles))
    ), admitted AS (
      SELECT polrelid, 'select' AS cmd FROM pol WHERE polcmd IN ('r', '*') AND NOT using_false
      UNION SELECT polrelid, 'delete' FROM pol WHERE polcmd IN ('d', '*') AND NOT using_false
      UNION SELECT polrelid, 'insert' FROM pol WHERE polcmd IN ('a', '*') AND NOT check_false
      UNION SELECT polrelid, 'update' FROM pol WHERE polcmd IN ('w', '*') AND NOT using_false AND NOT check_false
    )
    SELECT polrelid::regclass AS tbl, cmd FROM admitted
     WHERE CASE cmd WHEN 'delete' THEN has_table_privilege('app_user', polrelid, 'DELETE')
                    ELSE has_any_column_privilege('app_user', polrelid, upper(cmd)) END
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policy
                    WHERE polrelid = r.tbl AND polname = 'app_service_' || r.cmd) THEN
      IF r.cmd = 'select' OR r.cmd = 'delete' THEN
        EXECUTE format('CREATE POLICY %I ON %s FOR %s TO app_service USING (true)',
                       'app_service_' || r.cmd, r.tbl, r.cmd);
      ELSIF r.cmd = 'insert' THEN
        EXECUTE format('CREATE POLICY %I ON %s FOR INSERT TO app_service WITH CHECK (true)',
                       'app_service_' || r.cmd, r.tbl);
      ELSE
        EXECUTE format('CREATE POLICY %I ON %s FOR UPDATE TO app_service USING (true) WITH CHECK (true)',
                       'app_service_' || r.cmd, r.tbl);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Refuse the migration unless each login role's reach is exactly its
-- allowlist, and nothing in that reach is a superuser, bypasses RLS, can
-- create roles or replicate, or owns an object in this database. pg_has_role(.., 'MEMBER')
-- is transitive and ignores INHERIT, i.e. it is what SET ROLE can reach.
DO $$
DECLARE
  login text;
  allowed text[];
  r record;
BEGIN
  FOR login, allowed IN VALUES
    ('isaflow_app',     ARRAY['isaflow_app', 'app_user']),
    ('isaflow_service', ARRAY['isaflow_service', 'app_service', 'app_user'])
  LOOP
    FOR r IN SELECT oid, rolname, rolsuper, rolbypassrls, rolcreaterole, rolreplication
               FROM pg_roles WHERE pg_has_role(login, oid, 'MEMBER') LOOP
      IF NOT r.rolname = ANY (allowed) THEN
        RAISE EXCEPTION '910: % can reach role %, outside its allowlist %', login, r.rolname, allowed;
      END IF;
      IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolreplication THEN
        RAISE EXCEPTION '910: % can reach %, which is superuser, BYPASSRLS, CREATEROLE or REPLICATION', login, r.rolname;
      END IF;
      -- pg_shdepend records ownership in EVERY database of the cluster (prod
      -- and dev share one); the catalogs below cover this database even where
      -- pg_shdepend skips pinned objects.
      IF EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
                    AND refobjid = r.oid AND deptype = 'o')
         OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid)
         OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = r.oid)
         OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid)
         OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = r.oid)
         OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = r.oid) THEN
        RAISE EXCEPTION '910: % can reach %, which owns objects in this cluster', login, r.rolname;
      END IF;
    END LOOP;
  END LOOP;
  -- 'USAGE' is "holds the role's privileges without SET ROLE": on PG 15 the
  -- member's INHERIT attribute decides it, on PG 16 the grant's own INHERIT
  -- option (fixed when granted), so check the effect, not the attribute.
  IF (SELECT rolinherit FROM pg_roles WHERE rolname = 'isaflow_app')
     OR pg_has_role('isaflow_app', 'app_user', 'USAGE') THEN
    RAISE EXCEPTION '910: isaflow_app must be NOINHERIT and must not inherit app_user';
  END IF;
END $$;
