-- admin_audit_log and admin_impersonation_stash are the only evidence that a session is impersonated:
-- 675 control_session_impersonator() reads the impersonation_start row for the current session, and 677
-- impersonation_delegation_live() reads the stash row and the absence of an end row. Both tables were
-- created without RLS, and 348's blanket grant gave app_user INSERT, SELECT, UPDATE and DELETE on them -
-- so an impersonated tenant session could DELETE its own impersonation_start row and become a clean
-- independent reviewer, any tenant session could SELECT every administrative action across tenants, and
-- any tenant session could INSERT a stash row that keeps a delegation proof alive.
--
-- Who legitimately touches these tables, and on which role:
--   admin_audit_log        INSERT  platform_admin (withAdmin routes: impersonation_start, every logAdminAction,
--                                  admin settings) and the DATABASE_URL login role (end-impersonation, which runs
--                                  outside withAuth: impersonation_end / _end_failed / _revoked).
--                          SELECT  platform_admin (the admin audit page, dashboards), the login role
--                                  (end-impersonation), and the two SECURITY DEFINER readers above.
--                          Nothing updates or deletes a row: an impersonation ends with a new row.
--   admin_impersonation_stash INSERT platform_admin (stashAdminTokens from the impersonation route).
--                          SELECT  the login role (loadStash in end-impersonation) and 677's reader.
--                          DELETE  the login role only: end-impersonation deletes the consumed stash so the
--                                  administrator's tokens cannot be restored a second time. That DELETE is the
--                                  one rewrite kept; it is not evidence of the end (the impersonation_end row is),
--                                  and refusing it would leave the tokens restorable for the whole TTL.
--                          Nothing updates a row.
-- No tenant (app_user) path reads or writes either table: the readers it needs are SECURITY DEFINER, owned by
-- migration_admin (BYPASSRLS), so they see through the RLS enabled here.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE admin_audit_log FROM app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE admin_impersonation_stash FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE admin_audit_log FROM platform_admin;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE admin_impersonation_stash FROM platform_admin;

-- app_user keeps SELECT so a tenant query returns no rows rather than an error that confirms the table; with no
-- policy for app_user, RLS denies every row. platform_admin, migration_admin and the login role BYPASSRLS.
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_impersonation_stash ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_impersonation_stash FORCE ROW LEVEL SECURITY;

-- Append-only for every role, BYPASSRLS included: an audit row is never changed or removed, and a stash row is
-- never changed. Its DELETE stays with the login role for the reason above.
CREATE OR REPLACE FUNCTION public.impersonation_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Impersonation evidence refused: % rows are append-only', TG_TABLE_NAME USING ERRCODE='23514';
END;
$$;
REVOKE ALL ON FUNCTION public.impersonation_evidence_append_only() FROM PUBLIC;

DROP TRIGGER IF EXISTS admin_audit_log_append_only ON admin_audit_log;
CREATE TRIGGER admin_audit_log_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.impersonation_evidence_append_only();
DROP TRIGGER IF EXISTS admin_audit_log_truncate ON admin_audit_log;
CREATE TRIGGER admin_audit_log_truncate BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.impersonation_evidence_append_only();

DROP TRIGGER IF EXISTS admin_impersonation_stash_append_only ON admin_impersonation_stash;
CREATE TRIGGER admin_impersonation_stash_append_only BEFORE UPDATE ON admin_impersonation_stash
  FOR EACH ROW EXECUTE FUNCTION public.impersonation_evidence_append_only();
DROP TRIGGER IF EXISTS admin_impersonation_stash_truncate ON admin_impersonation_stash;
CREATE TRIGGER admin_impersonation_stash_truncate BEFORE TRUNCATE ON admin_impersonation_stash
  FOR EACH STATEMENT EXECUTE FUNCTION public.impersonation_evidence_append_only();
