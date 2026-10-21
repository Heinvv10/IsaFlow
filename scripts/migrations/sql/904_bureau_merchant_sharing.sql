-- 904: Bureau opt-in to merchant-pattern sharing (stored only) + bureau_audit_log (learning loop PR 1; Hein's
-- design answers 2026-10-21).
--
-- 1. bureaus.share_merchant_patterns BOOLEAN NOT NULL DEFAULT false.
--    A column, not a bureau_settings table: it is one flag per bureau, 1:1 with the row, read together with
--    the bureau, and bureaus has no other settings to group it with. Default OFF; only the bureau owner
--    (bureau_users.role = 'owner') may change it (pages/api/bureau/settings.ts). Nothing pools on it yet:
--    PR 2 reads it through poolEligibility.ts (a company counts only if it is linked to at least one bureau
--    and EVERY bureau it is linked to has opted in).
--
-- 2. bureau_audit_log — the audit home for bureau-level changes. audit_log.company_id is NOT NULL and a
--    bureau setting belongs to no single company, so it cannot go there.
--      Keyed on bureau_id (FK bureaus ON DELETE CASCADE: the history goes with its bureau, the one delete the
--      append-only trigger lets through, 877's recipe). actor_user_id is users.id (character varying) with
--      no FK, so a deleted user's changes stay recorded. old_value / new_value are JSONB.
--
--    Access model, and why it is deny-all for app_user. Bureau data is user-scoped, not tenant-scoped:
--    bureaus / bureau_companies / bureau_users carry no company_id and no RLS, and every bureau route runs
--    under withUserAuth on the BYPASSRLS pool role with no app.current_company_id and no SET ROLE; the route
--    authorises by bureau_users membership first (bureau/services/.claude.md, "TENANT SAFETY"). There is no
--    bureau GUC an app_user policy could test, and inventing one would be a parallel auth system. So the
--    strongest pattern available is the one 888's history table uses for app_user INSERT: the table is
--    under ENABLE + FORCE RLS with NO policy, and every non-owner role (app_user, platform_admin, PUBLIC)
--    holds no privilege on it. A request running as app_user (every withAuth route, MCP, the platform
--    portal's app connection) can neither read nor write it, even with injected SQL; only the pool role
--    (BYPASSRLS, the migration owner on prod) reaches it, and only bureauSettingsService.ts writes it,
--    after the owner check. rls-policy-coverage checks only company_id tables, so it cannot see this
--    one; tests/integration/bureau-audit-log-rls.int.test.ts pins the deny-all instead.
--
--    Append-only for every role, the owner included (877's trigger): it refuses UPDATE, DELETE and TRUNCATE;
--    the one delete it lets through is the one that follows a deleted bureau (by then the bureau row is gone).
--
-- Rollback (nothing else references either object; the audit history is lost with the table):
--   DROP TABLE IF EXISTS public.bureau_audit_log;
--   DROP FUNCTION IF EXISTS public.bureau_audit_log_append_only();
--   ALTER TABLE public.bureaus DROP COLUMN IF EXISTS share_merchant_patterns;
-- Locks: ADD COLUMN with a constant default is catalogue-only (no rewrite); brief ACCESS EXCLUSIVE on bureaus.

ALTER TABLE bureaus ADD COLUMN IF NOT EXISTS share_merchant_patterns BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN bureaus.share_merchant_patterns IS
  'Bureau owner''s opt-in to share merchant patterns from its clients'' coding (past and future) with the ISAFlow pool. Default false. Stored only until the pool ships (learning loop PR 2). Every change is in bureau_audit_log.';

CREATE TABLE IF NOT EXISTS bureau_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bureau_id     UUID NOT NULL REFERENCES bureaus(id) ON DELETE CASCADE,
  -- users.id is character varying(255), not uuid; no FK so the record outlives the user.
  actor_user_id TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('setting_changed')),
  setting       TEXT NOT NULL CHECK (setting IN ('share_merchant_patterns')),
  old_value     JSONB,
  new_value     JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bureau_audit_log_bureau_created_idx ON bureau_audit_log (bureau_id, created_at DESC, id DESC);

ALTER TABLE public.bureau_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bureau_audit_log FORCE ROW LEVEL SECURITY;

-- No policy, and no privilege for any non-owner role (default privileges grant app_user and platform_admin
-- ALL on a new table, so they are revoked by name).
DO $$
DECLARE r RECORD; p RECORD;
BEGIN
  FOR p IN SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'bureau_audit_log' LOOP
    EXECUTE pg_catalog.format('DROP POLICY %I ON public.bureau_audit_log', p.policyname);
  END LOOP;
  FOR r IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'bureau_audit_log'
      AND grantee <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                      WHERE c.oid = 'public.bureau_audit_log'::pg_catalog.regclass)
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON public.bureau_audit_log FROM %I', r.grantee);
  END LOOP;
  REVOKE ALL ON public.bureau_audit_log FROM PUBLIC;
END $$;

CREATE OR REPLACE FUNCTION public.bureau_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Nested, not AND: a TRUNCATE has no OLD row to read.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.bureaus b WHERE b.id = OLD.bureau_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION public.bureau_audit_log_append_only() FROM PUBLIC;

DROP TRIGGER IF EXISTS bureau_audit_log_append_only ON bureau_audit_log;
CREATE TRIGGER bureau_audit_log_append_only
  BEFORE UPDATE OR DELETE ON bureau_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.bureau_audit_log_append_only();
DROP TRIGGER IF EXISTS bureau_audit_log_no_truncate ON bureau_audit_log;
CREATE TRIGGER bureau_audit_log_no_truncate
  BEFORE TRUNCATE ON bureau_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.bureau_audit_log_append_only();

DO $$
DECLARE
  v_ok pg_catalog.bool;
BEGIN
  SELECT c.relrowsecurity AND c.relforcerowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bureau_audit_log')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.bureau_audit_log', 'SELECT')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.bureau_audit_log', 'INSERT')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.bureau_audit_log', 'UPDATE')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.bureau_audit_log', 'DELETE')
    INTO v_ok
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.bureau_audit_log'::pg_catalog.regclass;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 904: bureau_audit_log is not deny-all (FORCE RLS, no policy, no app_user privilege)';
  END IF;
END $$;

COMMENT ON TABLE bureau_audit_log IS
  'Append-only audit of bureau-level changes (who, when, old -> new). Deny-all to app_user; written by bureauSettingsService.ts on the pool role after the bureau-owner check.';
