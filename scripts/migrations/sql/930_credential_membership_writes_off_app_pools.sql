-- Migration 930 (S-07c): credential and membership writes off the app pools.
--
-- SQL injection on either app pool can forge request.jwt.claims and
-- app.current_company_id, and every RLS policy below keyed on auth.uid() or
-- the company claim then admits the forged row. These tables hold rows that a
-- privileged path later honours as an identity, a credential, a membership or
-- a role, so a forged row is a minted credential:
--   personal_access_tokens, oauth_authorisations   live bearer tokens;
--   capture_api_keys                               a live upload credential,
--                                                  acting as its creator (or,
--                                                  with none, as manager);
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
--   last_used_at/_ip         bearer and capture-key validation stamp them on
--                            the service pool.
-- revoked_at and is_active are not granted back: an UPDATE that can set them
-- can clear them, and revive a revoked token. DELETE stays where it only
-- removes access. A SECURITY DEFINER function runs as its owner, which may
-- write any of them, so every definer (a trigger function needs no EXECUTE
-- grant to run) must be listed, reviewed, in public.app_definer_reviews with
-- the hash of its body; an unlisted or changed one is a violation.
-- (Reading the source instead was evaded every round: comments, quoting,
-- U& identifiers, BEGIN ATOMIC bodies, views, triggers.)
-- auth_password_reset_tokens and admin_impersonation_stash lose every
-- privilege, as 918 did for the verification tokens (the stash's target and
-- the token hashes are what the attack needs to read).
--
-- Also (S-07c LOWs):
--   C1 refresh_customer_invoice_view_summary_if_due() refreshes at most once
--      per 10 minutes and never concurrently, and says whether it refreshed;
--      the old name delegates to it. App roles may EXECUTE neither: the cron
--      calls it on the migration_admin pool. A caller could otherwise hold its
--      lock to the end of a long transaction of its own (breaker round 2), as
--      it could loop the old one. The state row is unreadable by app roles.
--   C3 waitlist_signups gets row security. The public form keeps INSERT of its
--      own columns; nothing else for app roles. The admin site (platform_admin,
--      BYPASSRLS) reads and promotes as before.
--
-- Every rule is added to app_pool_reach_violations() (920), which this
-- migration and every deploy (scripts/check-app-login-roles.ts) run.
--
-- Deploy window: migrations apply before the code switch. Until the new code
-- is live (and after a code-only rollback) the previous release's writes to
-- these tables are refused 42501 and answer an error, minting nothing: PAT,
-- OAuth app and capture-key create AND revoke, OAuth code exchange and
-- refresh (connected MCP clients must reconnect), invitation create, password
-- reset, end-impersonation, and the public waitlist form (its RETURNING needs
-- SELECT). Reads, bearer validation, invite acceptance and admin suspension
-- (platform_admin) keep working.

REVOKE INSERT, UPDATE ON public.company_invitations FROM app_user, PUBLIC;
REVOKE INSERT, UPDATE ON public.oauth_apps FROM app_user, PUBLIC;
REVOKE INSERT, UPDATE ON public.oauth_authorisation_codes FROM app_user, PUBLIC;

REVOKE INSERT, UPDATE ON public.company_users FROM app_user, PUBLIC;
GRANT UPDATE (role) ON public.company_users TO app_user;

REVOKE INSERT, UPDATE ON public.personal_access_tokens FROM app_user, PUBLIC;
GRANT UPDATE (last_used_at, last_used_ip) ON public.personal_access_tokens TO app_user;

REVOKE INSERT, UPDATE ON public.oauth_authorisations FROM app_user, PUBLIC;
GRANT UPDATE (last_used_at, last_used_ip) ON public.oauth_authorisations TO app_user;

REVOKE INSERT, UPDATE ON public.capture_api_keys FROM app_user, PUBLIC;
GRANT UPDATE (last_used_at) ON public.capture_api_keys TO app_user;

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

-- C1: one refresh at a time, at most one per 10 minutes. The lock is the state
-- table's, which no app role may lock: an advisory key could be held by any
-- session that can name it.
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
  -- A second caller while one refresh runs does nothing.
  BEGIN
    LOCK TABLE public.matview_refresh_state IN EXCLUSIVE MODE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN false;
  END;
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
GRANT EXECUTE ON FUNCTION public.refresh_customer_invoice_view_summary_if_due() TO migration_admin;

-- The old name takes the same path. The previous release's cron calls it on the
-- service pool, which may no longer: until the new code is live the nightly
-- refresh fails (the summary stays a day stale), which is the window's cost.
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
REVOKE ALL ON FUNCTION public.refresh_customer_invoice_view_summary() FROM PUBLIC, app_service;
GRANT EXECUTE ON FUNCTION public.refresh_customer_invoice_view_summary() TO migration_admin;

-- Every SECURITY DEFINER function outside the catalog, reviewed: its signature
-- as regprocedure prints it under search_path pg_catalog, public, what it
-- writes, and app_definer_hash() at review: the whole definition (body,
-- SECURITY DEFINER, SET search_path and the other settings) and its owner, so
-- an ALTER FUNCTION is a change too (breaker round 5). The hash is of THIS
-- server's definitions: a major-version upgrade can deparse them differently
-- and is then refused until a migration re-reviews the rows. A new definer, or a CREATE OR
-- REPLACE that changes one, is refused on every deploy (and in CI, by
-- s07c-credential-writes.migration.int.test.ts) until the migration that
-- makes it inserts or updates its row.
CREATE OR REPLACE FUNCTION public.app_definer_hash(p_fn oid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid) || ' owner ' || pg_catalog.pg_get_userbyid(p.proowner))
    FROM pg_catalog.pg_proc p WHERE p.oid = p_fn
$$;
REVOKE ALL ON FUNCTION public.app_definer_hash(oid) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.app_definer_reviews (
  signature text PRIMARY KEY,
  writes    text NOT NULL,
  body_md5  text NOT NULL
);
REVOKE ALL ON public.app_definer_reviews FROM app_user, PUBLIC;
INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(p.oid)
  FROM (VALUES
    ('auth.set_default_company(uuid,uuid)', 'company_users.is_default of the caller''s own memberships only'),
    ('auth.user_admin_companies()', 'nothing (read)'),
    ('auth.user_admin_companies(text)', 'nothing (read)'),
    ('auth.user_companies()', 'nothing (read)'),
    ('approval_company_member_name(uuid,text)', 'nothing (read)'),
    ('approval_company_member_profile(uuid,text)', 'nothing (read)'),
    ('approval_company_other_members(uuid,text)', 'nothing (read)'),
    ('approval_enforcement_set(uuid,text,boolean,text)', 'approval_enforcement, audit_log (R-035; no credential or membership)'),
    ('approval_request_decide(uuid,uuid,text,text,text,text)', 'approval_requests, audit_log (R-035)'),
    ('approval_request_lock(uuid,uuid)', 'nothing (row lock)'),
    ('approval_request_raise(uuid,text,uuid,uuid,text)', 'approval_requests (R-035)'),
    ('approval_request_rebind(uuid,uuid,uuid,text)', 'approval_requests (R-035)'),
    ('approval_rule_create(uuid,text,text,text,text,text,numeric,text)', 'approval_rules (R-035)'),
    ('approval_rule_delete(uuid,uuid,text)', 'approval_rules (R-035)'),
    ('approval_rule_lock(uuid,uuid,text)', 'nothing (row lock)'),
    ('approval_rule_update(uuid,uuid,text,text,text,text,numeric,text,boolean)', 'approval_rules (R-035)'),
    ('audit_check_run_record(jsonb,jsonb)', 'audit_check_runs, audit_check_results'),
    ('audit_snapshot_record(jsonb,jsonb,jsonb,jsonb)', 'audit_snapshots and their lines'),
    ('company_member_directory(uuid)', 'nothing (read)'),
    ('create_company_with_owner(jsonb)', 'a NEW company, with its caller as owner (company_users); grants nothing over an existing one'),
    ('current_company_invoice_view_summary()', 'nothing (read, 919)'),
    ('invite_token_company_name()', 'nothing (read, 648)'),
    ('payment_approval_cleared(uuid,text,uuid)', 'nothing (read)'),
    ('refresh_customer_invoice_view_summary()', 'via the _if_due one; migration_admin only (930)'),
    ('refresh_customer_invoice_view_summary_if_due()', 'matview_refresh_state; migration_admin only (930)'),
    ('shared_pool_lookup(uuid,text[])', 'nothing (read, 906): exact merchant keys, caller''s active pool-eligible company only'),
    ('shared_pool_publish(jsonb,integer)', 'shared_merchant_patterns only: replaces the whole anonymised pool under an EXCLUSIVE lock, reading merchant_categories (906); migration_admin only'),
    ('seed_company_afs_statement_lines(uuid)', 'afs_statement_lines of the given company (called by create_company_with_owner)'),
    ('seed_company_chart_of_accounts(uuid)', 'gl_accounts of the given company (same)'),
    ('seed_company_default_taxonomy(uuid)', 'company taxonomy rows (same)'),
    ('seed_company_fiscal_periods(uuid)', 'fiscal_periods of the given company (same)'),
    ('entity_change_capture()', 'trigger: entity_changes only'),
    ('credit_note_approval_gate()', 'trigger: refuses, writes nothing'),
    ('customer_invoice_approval_gate()', 'trigger: refuses, writes nothing'),
    ('fx_document_currency_gate()', 'trigger: refuses, writes nothing'),
    ('fx_settlement_refusal()', 'trigger: refuses, writes nothing'),
    ('manual_journal_approval_gate()', 'trigger: refuses, writes nothing'),
    ('payment_batch_approval_gate()', 'trigger: refuses, writes nothing'),
    ('payment_batch_member_gate()', 'trigger: refuses, writes nothing'),
    ('supplier_invoice_approval_gate()', 'trigger: refuses, writes nothing'),
    ('supplier_payment_approval_gate()', 'trigger: refuses, writes nothing')
  ) v(signature, writes)
  JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(v.signature)
ON CONFLICT (signature) DO NOTHING;

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
   WHERE (p.priv = 'TRUNCATE' OR NOT ruled.may_delete)
     AND pg_catalog.has_table_privilege(reach.oid, ruled.rel, p.priv)
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

-- The writes this takes from the app pools run on migration_admin, and admin
-- suspension still revokes on platform_admin: refuse, before the code switch,
-- a database where either could not make them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('migration_admin', 'public.company_invitations', 'SELECT, INSERT, UPDATE, DELETE'),
      ('migration_admin', 'public.company_users', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.users', 'SELECT'),
      ('migration_admin', 'public.personal_access_tokens', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.oauth_apps', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.oauth_authorisation_codes', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.oauth_authorisations', 'SELECT, INSERT, UPDATE'),
      ('migration_admin', 'public.auth_password_reset_tokens', 'SELECT, INSERT, UPDATE, DELETE'),
      ('migration_admin', 'public.admin_impersonation_stash', 'SELECT, INSERT, DELETE'),
      ('migration_admin', 'public.capture_api_keys', 'SELECT, INSERT, UPDATE'),
      ('platform_admin', 'public.waitlist_signups', 'SELECT, UPDATE'),
      ('platform_admin', 'public.personal_access_tokens', 'UPDATE'),
      ('platform_admin', 'public.oauth_authorisations', 'UPDATE')) w(role, tbl, privs),
    LATERAL pg_catalog.unnest(pg_catalog.string_to_array(w.privs, ', ')) p(priv)
  LOOP
    -- One privilege at a time: has_table_privilege with a list is true if ANY is held.
    IF pg_catalog.to_regrole(r.role) IS NOT NULL AND NOT pg_catalog.has_table_privilege(r.role, r.tbl, r.priv) THEN
      RAISE EXCEPTION '930: % cannot % %, which the S-07c code writes on it', r.role, r.priv, r.tbl;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege('migration_admin', 'public.company_member_role_is_owner(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '930: migration_admin cannot EXECUTE company_member_role_is_owner(text), which assertCanInvite calls';
  END IF;
  -- Adding a company keeps working only while the definer's owner may write
  -- the membership itself, not through app_user's grant this revokes.
  IF NOT pg_catalog.has_table_privilege((SELECT p.proowner FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.create_company_with_owner(jsonb)'::pg_catalog.regprocedure), 'public.company_users', 'INSERT') THEN
    RAISE EXCEPTION '930: the owner of create_company_with_owner(jsonb) cannot INSERT company_users, which the S-07c code writes on it';
  END IF;
END $$;
