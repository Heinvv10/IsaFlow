-- 999: users.email is unique case- and space-insensitively (admin follow-ups 2026-11-16, Package B).
--
-- users_email_key is UNIQUE (email), exact text, so `X@y.co` and `x@y.co` could be two users, two
-- profiles for one mailbox. Invite accept refused a case variant with a SELECT before its INSERT
-- (#1440), but two brand-new invitees accepting at the same instant could both pass that read. This
-- index makes the database the guarantee: one row per lower(btrim(email)), whoever writes it.
--
-- Stored values are NOT rewritten (Hein, 2026-11-16): a row already held in mixed case keeps it, and
-- the index compares its normal form. Every writer stores lower(btrim(email)) from now on.
--
-- Precondition: no two rows share lower(btrim(email)). Census on 2026-11-16: production 15 users,
-- 0 duplicate groups; isaflow_dev 133 users, 0. Run it again before the deploy:
--   SELECT lower(btrim(email)), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
-- If a duplicate exists the DO block below refuses with the number of groups (never the addresses,
-- which would land in the deploy log), this file rolls back, and the deploy stops at its migrate step
-- before any colour is switched. Resolving a duplicate is a data decision; this file makes none.
--
-- Owner: users is owned by migration_admin on production and the deploy role (`postgres`, not a
-- superuser) is a member of it, which is what CREATE INDEX needs. The census SELECT needs that role's
-- BYPASSRLS (users has FORCE ROW LEVEL SECURITY); were it ever to see fewer rows, the index build
-- itself still refuses a duplicate (23505), so the guarantee does not rest on the census.
--
-- LOCKS. LOCK TABLE ... IN SHARE MODE first, so no row can be written between the census and the
-- build (SHARE is what CREATE INDEX takes anyway: it blocks writes to users, not reads). Held to
-- COMMIT: apply-migrations.ts runs the file in one transaction. A few hundred rows, built in
-- milliseconds. If lock_timeout trips (a writer held users for more than 5 s), the file rolls back and
-- nothing is recorded: rerun it. IF NOT EXISTS: a rerun changes nothing.
--
-- Rollback: DROP INDEX IF EXISTS public.users_email_lower_key;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.users IN SHARE MODE;

DO $$
DECLARE
  v_groups bigint;
BEGIN
  SELECT count(*) INTO v_groups FROM (
    SELECT 1 FROM public.users GROUP BY lower(btrim(email)) HAVING count(*) > 1
  ) d;
  IF v_groups > 0 THEN
    RAISE EXCEPTION '999: % group(s) of users rows share an email once lower-cased and trimmed; users_email_lower_key cannot be built', v_groups
      USING HINT = 'SELECT lower(btrim(email)), count(*) FROM users GROUP BY 1 HAVING count(*) > 1; resolve each group, then rerun.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON public.users (lower(btrim(email)));
