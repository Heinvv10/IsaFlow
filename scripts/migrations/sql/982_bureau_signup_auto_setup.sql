-- Migration 982: a bureau set up automatically when someone signs up as Accountant.
--
-- Until now only a platform admin created a bureau (convert-to-bureau, on
-- platform_admin). From this release /api/auth/verify-email also creates one,
-- for a sign-up whose stored sign-up type (the verification token row, written
-- at registration) is 'accountant': one bureau owned by the new user, created
-- in the same transaction as that user's new company, on the migration_admin
-- client verify-email already uses (signupBureauService.ts).
--
-- bureaus.created_via records which path made a bureau. The partial unique
-- index allows at most one 'signup_auto' bureau per owner, so a retried or
-- concurrent verification cannot create a second (INSERT ... ON CONFLICT DO
-- NOTHING). Admin conversions keep created_via = 'admin' through the default
-- and stay unrestricted (an owner may hold several).
--
-- Privileges: migration 932 proved only SELECT, UPDATE on bureaus and SELECT
-- on bureau_users for migration_admin. The sign-up path also INSERTs both and
-- flips users.account_type, so this grants those and refuses to ship without
-- them. No app role gains anything: app_pool_reach_violations() (920, 930,
-- 932) is re-run at the end, as every deploy runs it.
-- No new table, no SECURITY DEFINER function (so no app_definer_reviews row),
-- no RLS change: bureaus keeps its 932 policies.
-- ADD COLUMN with a constant default is catalogue-only (no table rewrite).
--
-- Deploy window: migrations apply before the code switch. The previous release
-- never names created_via and its admin inserts take the default, so it keeps
-- working before the switch and after a code-only rollback.
--
-- Rollback (the down SQL; list the auto-created bureaus first, the column
-- carries their provenance):
--   SELECT id, owner_user_id, name, created_at FROM public.bureaus WHERE created_via = 'signup_auto';
--   DROP INDEX IF EXISTS public.bureaus_one_signup_auto_per_owner;
--   ALTER TABLE public.bureaus DROP CONSTRAINT IF EXISTS bureaus_created_via_check;
--   ALTER TABLE public.bureaus DROP COLUMN IF EXISTS created_via;
--   -- Only where migration_admin did not hold these before 982 (it holds ALL on dev):
--   -- REVOKE INSERT ON public.bureaus, public.bureau_users FROM migration_admin;
--   -- REVOKE UPDATE (account_type) ON public.users FROM migration_admin;

ALTER TABLE public.bureaus
  ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'admin';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.bureaus'::pg_catalog.regclass AND conname = 'bureaus_created_via_check') THEN
    ALTER TABLE public.bureaus ADD CONSTRAINT bureaus_created_via_check
      CHECK (created_via IN ('admin', 'signup_auto'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS bureaus_one_signup_auto_per_owner
  ON public.bureaus (owner_user_id) WHERE created_via = 'signup_auto';

COMMENT ON COLUMN public.bureaus.created_via IS
  'admin = created by a platform admin (convert-to-bureau). signup_auto = created at email verification for a sign-up that chose Accountant; at most one per owner.';

-- The sign-up path writes on migration_admin. Grant what it needs, then refuse
-- to ship without it.
DO $$
DECLARE r record;
BEGIN
  IF pg_catalog.to_regrole('migration_admin') IS NULL THEN RETURN; END IF;
  GRANT INSERT ON public.bureaus, public.bureau_users TO migration_admin;
  GRANT UPDATE (account_type) ON public.users TO migration_admin;
  FOR r IN SELECT * FROM (VALUES
      ('public.bureaus', 'INSERT'), ('public.bureaus', 'SELECT'),
      ('public.bureau_users', 'INSERT'),
      ('public.company_users', 'SELECT'),
      ('public.audit_log', 'INSERT')) w(tbl, priv)
  LOOP
    IF NOT pg_catalog.has_table_privilege('migration_admin', r.tbl, r.priv) THEN
      RAISE EXCEPTION '982: migration_admin cannot % %, which sign-up bureau setup writes on it', r.priv, r.tbl;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_column_privilege('migration_admin', 'public.users', 'account_type', 'UPDATE') THEN
    RAISE EXCEPTION '982: migration_admin cannot UPDATE users.account_type';
  END IF;
END $$;

-- 932's rules still hold: no app pool login may write bureaus (the new column included).
DO $$
DECLARE v text;
BEGIN
  FOR v IN SELECT * FROM public.app_pool_reach_violations() ORDER BY 1 LOOP
    RAISE EXCEPTION '982: %', v;
  END LOOP;
END $$;
