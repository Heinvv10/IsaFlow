-- Migration 930 (S-07c): credential and membership writes off the app pools.
--
-- SQL injection on either app pool can forge request.jwt.claims and
-- app.current_company_id, and every RLS policy below keyed on auth.uid() or
-- the company claim then admits the forged row. These tables hold rows that a
-- privileged path later honours as an identity, a credential, a membership or
-- a role, so a forged row is a minted credential:
--   personal_access_tokens, oauth_authorisations   live bearer tokens;
--   oauth_authorisation_codes                      exchanged for one;
--   oauth_apps                                     says who may obtain one;
--   company_invitations                            accepted on the
--                                                  migration_admin pool;
--   company_users                                  the membership itself;
--   auth_password_reset_tokens                     sets any user's password;
--   admin_impersonation_stash                      restores an admin's session
--                                                  to its target_user_id.
-- Only privileges hold against such SQL (a trigger testing current_user and a
-- definer keyed on a claim are both steerable), so app_user, and through it
-- app_service and both logins, loses INSERT and UPDATE on them. The writes run
-- on the migration_admin pool from fixed statements keyed on the verified
-- session (S-07c). Column grants come back only for writes that cannot add
-- access:
--   company_users.role       the members screen changes a member's role;
--                            this needs an existing membership (residual);
--   last_used_at/_ip         bearer validation stamps them on the service pool.
-- revoked_at is not granted back: an UPDATE that can set it can clear it, and
-- revive a revoked token. DELETE stays where it only removes access.
-- auth_password_reset_tokens and admin_impersonation_stash lose every
-- privilege, as 918 did for the verification tokens (the stash's target and
-- the token hashes are what the attack needs to read).
--
-- Also (S-07c LOWs):
--   C1 refresh_customer_invoice_view_summary() refreshes at most once per 10
--      minutes and never concurrently, so a loop of calls is not a DoS;
--      refresh_customer_invoice_view_summary_if_due() does the same and says
--      whether it refreshed. The state row is unreadable by app roles.
--   C3 waitlist_signups gets row security. The public form keeps INSERT of its
--      own columns; nothing else for app roles. The admin site (platform_admin,
--      BYPASSRLS) reads and promotes as before.
--
-- Every rule is added to app_pool_reach_violations() (920), which this
-- migration and every deploy (scripts/check-app-login-roles.ts) run.
--
-- Deploy window: migrations apply before the code switch. Until the new code
-- is live, the previous release's PAT/OAuth/invitation/password-reset/
-- impersonation-end writes are refused 42501 and answer an error, minting
-- nothing; reads, bearer validation and invite acceptance keep working.

REVOKE INSERT, UPDATE ON public.company_invitations FROM app_user, PUBLIC;
REVOKE INSERT, UPDATE ON public.oauth_apps FROM app_user, PUBLIC;
REVOKE INSERT, UPDATE ON public.oauth_authorisation_codes FROM app_user, PUBLIC;

REVOKE INSERT, UPDATE ON public.company_users FROM app_user, PUBLIC;
GRANT UPDATE (role) ON public.company_users TO app_user;

REVOKE INSERT, UPDATE ON public.personal_access_tokens FROM app_user, PUBLIC;
GRANT UPDATE (last_used_at, last_used_ip) ON public.personal_access_tokens TO app_user;

REVOKE INSERT, UPDATE ON public.oauth_authorisations FROM app_user, PUBLIC;
GRANT UPDATE (last_used_at, last_used_ip) ON public.oauth_authorisations TO app_user;

REVOKE ALL ON public.auth_password_reset_tokens FROM app_user, PUBLIC;
REVOKE ALL ON public.admin_impersonation_stash FROM app_user, PUBLIC;
-- The pre-491 table: no code reads or writes it.
DO $$
BEGIN
  IF pg_catalog.to_regclass('public.password_reset_tokens') IS NOT NULL THEN
    REVOKE ALL ON public.password_reset_tokens FROM app_user, PUBLIC;
  END IF;
END $$;

-- C3: the public waitlist form inserts on the service pool; nothing else may.
ALTER TABLE public.waitlist_signups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.waitlist_signups FROM app_user, PUBLIC;
GRANT INSERT (name, email, signup_type, company_name, practice_name, phone, annual_turnover_cents, ip, user_agent)
  ON public.waitlist_signups TO app_user;
DROP POLICY IF EXISTS waitlist_public_insert ON public.waitlist_signups;
CREATE POLICY waitlist_public_insert ON public.waitlist_signups FOR INSERT TO app_user WITH CHECK (true);

-- C1: one refresh at a time, at most one per 10 minutes.
CREATE TABLE IF NOT EXISTS public.matview_refresh_state (
  view_name    text PRIMARY KEY,
  refreshed_at timestamptz NOT NULL
);
-- 348's default privileges grant app_user on every new table.
REVOKE ALL ON public.matview_refresh_state FROM app_user, PUBLIC;

-- The throttled refresh, returning whether it refreshed, under a new name:
-- 915 and 919 define the old one as RETURNS void, and a re-application of
-- either must still apply after this migration.
CREATE OR REPLACE FUNCTION public.refresh_customer_invoice_view_summary_if_due()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_last pg_catalog.timestamptz;
BEGIN
  -- A fixed key: a second caller while one refresh runs does nothing.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('refresh_customer_invoice_view_summary', 0)) THEN
    RETURN false;
  END IF;
  -- Read after the lock, so a refresh that committed meanwhile is seen.
  SELECT s.refreshed_at INTO v_last FROM public.matview_refresh_state s
   WHERE s.view_name = 'customer_invoice_view_summary_mv';
  IF v_last IS NOT NULL AND v_last > pg_catalog.clock_timestamp() - interval '10 minutes' THEN
    RETURN false;
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.customer_invoice_view_summary_mv;
  INSERT INTO public.matview_refresh_state (view_name, refreshed_at)
  VALUES ('customer_invoice_view_summary_mv', pg_catalog.clock_timestamp())
  ON CONFLICT (view_name) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_customer_invoice_view_summary_if_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_customer_invoice_view_summary_if_due() TO app_service;

-- The old name, which the previous release's cron calls, takes the same path.
CREATE OR REPLACE FUNCTION public.refresh_customer_invoice_view_summary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.refresh_customer_invoice_view_summary_if_due();
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_customer_invoice_view_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_customer_invoice_view_summary() TO app_service;

-- 920's rules, unchanged, plus one per table above.
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
  ),
  -- 930: per table, the columns an app role may still INSERT or UPDATE, and
  -- whether it may read and DELETE. Every other column privilege, and DELETE
  -- or TRUNCATE where not allowed, is a violation.
  rules (tbl, may_insert, may_update, may_read, may_delete) AS (VALUES
    ('public.company_invitations',        '{}'::text[], '{}'::text[],                    true,  true),
    ('public.company_users',              '{}',         '{role}',                        true,  true),
    ('public.personal_access_tokens',     '{}',         '{last_used_at,last_used_ip}',   true,  true),
    ('public.oauth_apps',                 '{}',         '{}',                            true,  true),
    ('public.oauth_authorisation_codes',  '{}',         '{}',                            true,  true),
    ('public.oauth_authorisations',       '{}',         '{last_used_at,last_used_ip}',   true,  true),
    ('public.auth_password_reset_tokens', '{}',         '{}',                            false, false),
    ('public.password_reset_tokens',      '{}',         '{}',                            false, false),
    ('public.admin_impersonation_stash',  '{}',         '{}',                            false, false),
    ('public.matview_refresh_state',      '{}',         '{}',                            false, false),
    ('public.waitlist_signups',
     '{name,email,signup_type,company_name,practice_name,phone,annual_turnover_cents,ip,user_agent}',
                                                        '{}',                            false, false)
  ),
  ruled AS (
    SELECT pg_catalog.to_regclass(r.tbl) AS rel, r.* FROM rules r WHERE pg_catalog.to_regclass(r.tbl) IS NOT NULL
  )
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s users.email', reach.rolname, p.priv)
    FROM reach CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) p(priv)
   WHERE pg_catalog.has_column_privilege(reach.oid, 'public.users', 'email', p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s auth_email_verification_tokens', reach.rolname, p.priv)
    FROM reach CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
   -- SELECT, INSERT and UPDATE can also be granted per column: count those.
   WHERE CASE WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE')
              THEN pg_catalog.has_any_column_privilege(reach.oid, pg_catalog.to_regclass('public.auth_email_verification_tokens'), p.priv)
              ELSE pg_catalog.has_table_privilege(reach.oid, pg_catalog.to_regclass('public.auth_email_verification_tokens'), p.priv) END
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can SELECT the materialized view %s', reach.rolname, c.oid::regclass)
    FROM reach
   CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'm' AND n.nspname IN ('public', 'auth', 'app', 'platform_shared')
     AND pg_catalog.has_any_column_privilege(reach.oid, c.oid, 'SELECT')
  UNION ALL
  -- has_column_privilege counts table-level grants, PUBLIC and inherited roles.
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s %s.%s', reach.rolname, p.priv, ruled.rel, a.attname)
    FROM reach
   CROSS JOIN ruled
    JOIN pg_catalog.pg_attribute a ON a.attrelid = ruled.rel AND a.attnum > 0 AND NOT a.attisdropped
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('SELECT')) p(priv)
   WHERE CASE p.priv WHEN 'INSERT' THEN NOT (a.attname::text = ANY (ruled.may_insert))
                     WHEN 'UPDATE' THEN NOT (a.attname::text = ANY (ruled.may_update))
                     ELSE NOT ruled.may_read END
     AND pg_catalog.has_column_privilege(reach.oid, ruled.rel, a.attnum, p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s (reachable from an app pool login) can %s %s', reach.rolname, p.priv, ruled.rel)
    FROM reach
   CROSS JOIN ruled
   CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) p(priv)
   WHERE NOT ruled.may_delete
     AND pg_catalog.has_table_privilege(reach.oid, ruled.rel, p.priv)
  UNION ALL
  SELECT 'waitlist_signups has no row security'
   WHERE NOT COALESCE((SELECT c.relrowsecurity FROM pg_catalog.pg_class c
                        WHERE c.oid = pg_catalog.to_regclass('public.waitlist_signups')), true)
$$;
REVOKE ALL ON FUNCTION public.app_pool_reach_violations() FROM PUBLIC;

DO $$
DECLARE
  v text;
BEGIN
  FOR v IN SELECT * FROM public.app_pool_reach_violations() ORDER BY 1 LOOP
    RAISE EXCEPTION '930: %', v;
  END LOOP;
END $$;
