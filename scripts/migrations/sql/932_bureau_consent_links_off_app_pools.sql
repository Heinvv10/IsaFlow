-- Migration 932: bureau consent and client links off the app pools.
--
-- bureaus had no row security, and app_user (so both app pool logins) held
-- INSERT, UPDATE and DELETE on bureaus, bureau_users and bureau_companies.
-- bureau_companies' policy keys on the company claim, and SQL injected on
-- either pool can forge it (S-07c, migration 930). So any tenant could:
--   switch any bureau's merchant-sharing consent on (bureaus.
--   share_merchant_patterns), the POPIA consent the shared merchant pool (931)
--   trusts;
--   link its company to a sharing bureau, or unlink it from the non-sharing
--   bureau that keeps it out of the pool, and so read the pool;
--   join any bureau (bureau_users), and so read every client of it through
--   /api/bureau, which keys on membership;
--   take a bureau over (owner_user_id), create one in another user's name, or
--   delete one with its links.
-- Only privileges hold against forged claims, so the app roles lose every
-- write on the three tables (UPDATE on bureaus.name too: no code writes it).
-- The writes run on the migration_admin pool, from fixed statements whose
-- authorization is read live inside the statement, keyed on the verified
-- session (bureauSettingsService, bureauCompanyLinkService):
--   consent      the bureau's owner (bureaus.owner_user_id), row locked, one
--                bureau_audit_log row per change;
--   link         the bureau's owner who is also the company's owner or admin;
--   unlink       the bureau's owner, OR the company's owner or admin (a
--                company can always withdraw).
-- Creating a bureau stays where it runs today: the admin convert route, on
-- platform_admin. Nothing on the app pools creates one.
-- bureau_audit_log stays deny-all to the app roles (904). migration_admin
-- gets SELECT and INSERT on it: the toggle's audit row and the settings
-- page's history are written and read there. (Before this, no role but its
-- owner held any privilege on it, so the toggle failed on both app pools.)
-- Row security on bureaus and bureau_users, for app_user: a bureau is read by
-- its owner and its members, a membership row by its own user. A linked
-- company does not read the bureau row. bureau_companies keeps its company
-- policy for reads. app_service gets its usual mirrors
-- (app_service_sync_policies(), 915): the service pool, where every bureau
-- route reads, has no identity and keeps reading every row. platform_admin
-- bypasses row security.
-- No new SECURITY DEFINER function, so no new app_definer_reviews row.
--
-- Every rule is added to app_pool_reach_violations() (920, 930), which this
-- migration and every deploy (scripts/check-app-login-roles.ts) run.
--
-- Deploy window: migrations apply before the code switch. Until the new code
-- is live, and after a code-only rollback, the previous release's consent
-- toggle, client link and client unlink are refused 42501 and answer an
-- error, writing nothing (the toggle already failed: see bureau_audit_log
-- above). Bureau pages, the admin convert route and pool eligibility keep
-- working. Production holds no bureau rows (read-only check, 2026-10-24).
--
-- Rollback (break-glass, in docs/runbooks/s07b-app-pool-login-roles.md):
--   GRANT INSERT, UPDATE, DELETE ON public.bureaus, public.bureau_users,
--     public.bureau_companies TO app_user;
--   ALTER TABLE public.bureaus DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.bureau_users DISABLE ROW LEVEL SECURITY;
-- which reopens the forgery, and makes every deploy's
-- app_pool_reach_violations() check refuse until this migration's state is
-- restored.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bureaus FROM app_user, app_service, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bureau_users FROM app_user, app_service, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bureau_companies FROM app_user, app_service, PUBLIC;
REVOKE ALL ON public.bureau_audit_log FROM app_user, app_service, PUBLIC;
GRANT SELECT, INSERT ON public.bureau_audit_log TO migration_admin;

ALTER TABLE public.bureaus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bureau_users ENABLE ROW LEVEL SECURITY;

-- A membership row is read by its own user only: a policy here that read
-- bureaus would recurse through bureaus' own policy.
DROP POLICY IF EXISTS bureau_users_own_read ON public.bureau_users;
CREATE POLICY bureau_users_own_read ON public.bureau_users FOR SELECT TO app_user
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS bureaus_owner_member_read ON public.bureaus;
CREATE POLICY bureaus_owner_member_read ON public.bureaus FOR SELECT TO app_user
  USING (owner_user_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.bureau_users bu WHERE bu.bureau_id = bureaus.id AND bu.user_id = auth.uid()));

SELECT public.app_service_sync_policies();

-- 930's rules, unchanged, plus 932's: the three tables read-only, the audit
-- log unreadable, row security on bureaus, bureau_users and
-- bureau_companies, and no TRIGGER privilege on any table. A migration that changes this function again keeps them.
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
  -- 930 (and 932): per table, the columns an app role may still INSERT or UPDATE, and
  -- whether it may read and DELETE. Every other column privilege, DELETE where
  -- not allowed, and TRUNCATE anywhere, is a violation.
  rules (tbl, may_insert, may_update, may_read, may_delete) AS (VALUES
    ('public.company_invitations',        '{}'::text[], '{}'::text[],                    true,  true),
    ('public.company_users',              '{}',         '{role}',                        true,  true),
    ('public.personal_access_tokens',     '{}',         '{last_used_at,last_used_ip}',   true,  true),
    ('public.oauth_apps',                 '{}',         '{}',                            true,  true),
    ('public.oauth_authorisation_codes',  '{}',         '{}',                            true,  true),
    ('public.oauth_authorisations',       '{}',         '{last_used_at,last_used_ip}',   true,  true),
    ('public.capture_api_keys',           '{}',         '{last_used_at}',                true,  true),
    ('public.auth_password_reset_tokens', '{}',         '{}',                            false, false),
    ('public.password_reset_tokens',      '{}',         '{}',                            false, false),
    ('public.admin_impersonation_stash',  '{}',         '{}',                            false, false),
    ('public.matview_refresh_state',      '{}',         '{}',                            false, false),
    ('public.app_definer_reviews',        '{}',         '{}',                            false, false),
    ('public.waitlist_signups',
     '{name,email,signup_type,company_name,practice_name,phone,annual_turnover_cents,ip,user_agent}',
                                                        '{}',                            false, false),
    -- 932: bureaus, their members and their client links are read-only to the app pools.
    ('public.bureaus',                    '{}',         '{}',                            true,  false),
    ('public.bureau_users',               '{}',         '{}',                            true,  false),
    ('public.bureau_companies',           '{}',         '{}',                            true,  false),
    ('public.bureau_audit_log',           '{}',         '{}',                            false, false)
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
   WHERE (p.priv = 'TRUNCATE' OR NOT ruled.may_delete)
     AND pg_catalog.has_table_privilege(reach.oid, ruled.rel, p.priv)
  UNION ALL
  -- 932: TRIGGER on any table. A trigger an app role creates on a table the
  -- migration_admin pool writes (bureau_companies, say) runs its function in
  -- that pool's session, as migration_admin.
  SELECT pg_catalog.format('%s (reachable from an app pool login) can TRIGGER %s', reach.rolname, c.oid::regclass)
    FROM reach
   CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_catalog.has_table_privilege(reach.oid, c.oid, 'TRIGGER')
  UNION ALL
  -- A definer runs as its owner, so no privilege rule sees what it writes.
  SELECT pg_catalog.format('%s is a SECURITY DEFINER function %s app_definer_reviews: review what it writes, then insert or update its row, with public.app_definer_hash(oid), in the migration that %s it',
                           p.oid::regprocedure, CASE WHEN r.signature IS NULL THEN 'not in' ELSE 'changed since its row in' END,
                           CASE WHEN r.signature IS NULL THEN 'creates' ELSE 'changes' END)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN public.app_definer_reviews r ON r.signature = p.oid::regprocedure::text
   WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND r.body_md5 IS DISTINCT FROM public.app_definer_hash(p.oid)
  UNION ALL
  SELECT pg_catalog.format('%s has no row security', t.tbl)
    FROM (VALUES ('waitlist_signups'), ('bureaus'), ('bureau_users'), ('bureau_companies')) t(tbl)
   WHERE NOT COALESCE((SELECT c.relrowsecurity FROM pg_catalog.pg_class c
                        WHERE c.oid = pg_catalog.to_regclass('public.' || t.tbl)), true)
$$;
REVOKE ALL ON FUNCTION public.app_pool_reach_violations() FROM PUBLIC;

DO $$
DECLARE
  v text;
BEGIN
  FOR v IN SELECT * FROM public.app_pool_reach_violations() ORDER BY 1 LOOP
    RAISE EXCEPTION '932: %', v;
  END LOOP;
END $$;

-- The writes this takes from the app pools run on migration_admin, and the
-- admin convert route creates bureaus on platform_admin: refuse, before the
-- code switch, a database where either could not make them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('migration_admin', 'public.bureaus', 'SELECT, UPDATE'),
      ('migration_admin', 'public.bureau_users', 'SELECT'),
      ('migration_admin', 'public.bureau_companies', 'SELECT, INSERT, DELETE'),
      ('migration_admin', 'public.bureau_audit_log', 'SELECT, INSERT'),
      ('migration_admin', 'public.company_users', 'SELECT'),
      ('migration_admin', 'public.companies', 'SELECT'),
      ('migration_admin', 'public.users', 'SELECT'),
      ('platform_admin', 'public.bureaus', 'SELECT, INSERT'),
      ('platform_admin', 'public.bureau_users', 'INSERT')) w(role, tbl, privs),
    LATERAL pg_catalog.unnest(pg_catalog.string_to_array(w.privs, ', ')) p(priv)
  LOOP
    -- One privilege at a time: has_table_privilege with a list is true if ANY is held.
    IF pg_catalog.to_regrole(r.role) IS NOT NULL AND NOT pg_catalog.has_table_privilege(r.role, r.tbl, r.priv) THEN
      RAISE EXCEPTION '932: % cannot % %, which the bureau code writes on it', r.role, r.priv, r.tbl;
    END IF;
  END LOOP;
  -- Both bypass row security, which the bureau writes rely on (the toggle reads
  -- and locks bureaus; the audit log is under FORCE row security with no policy).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('migration_admin', 'platform_admin') AND NOT rolbypassrls) THEN
    RAISE EXCEPTION '932: migration_admin and platform_admin must bypass row security, which the bureau code relies on';
  END IF;
END $$;
