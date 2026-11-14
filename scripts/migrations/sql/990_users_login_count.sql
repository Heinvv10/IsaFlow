-- scripts/migrations/sql/990_users_login_count.sql
-- Admin audit 2026-11-14 item 1.1: the admin console's "Login Count" read COUNT(*) FROM user_sessions, a table
-- nothing has written since GoTrue took over sessions, so it was 0 for every user. Migration 349 dropped
-- users.login_count together with last_login; 353 re-added last_login only. Re-add the counter so sign-in can
-- maintain it next to last_login (src/lib/auth/recordSignIn.ts).
-- Additive and idempotent: existing rows start at 0 (the old session count was never a login count).
--
-- The stamp runs on the migration_admin pool. Production's migration_admin is not known to hold UPDATE on
-- users (930/932/945 list SELECT; 982 had to grant UPDATE (account_type) itself; the dev dump has ALL), so this
-- file grants exactly the two columns the stamp writes and refuses to apply without them, as 982 does. No app
-- role is granted anything here (902: app_user and app_service stay unable to write users standing columns).
--
-- The runner applies each file in its own transaction: ADD COLUMN takes users' ACCESS EXCLUSIVE lock for an
-- instant (a constant default rewrites nothing), but would queue every request behind a long-running
-- transaction while it waits. lock_timeout makes it fail fast and be re-run instead.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS login_count integer NOT NULL DEFAULT 0;

DO $$
DECLARE col text;
BEGIN
  IF pg_catalog.to_regrole('migration_admin') IS NULL THEN RETURN; END IF;
  GRANT UPDATE (last_login, login_count) ON public.users TO migration_admin;
  FOREACH col IN ARRAY ARRAY['last_login', 'login_count'] LOOP
    IF NOT pg_catalog.has_column_privilege('migration_admin', 'public.users', col, 'UPDATE') THEN
      RAISE EXCEPTION '990: migration_admin cannot UPDATE users.%, which the sign-in stamp writes', col;
    END IF;
  END LOOP;
END $$;
