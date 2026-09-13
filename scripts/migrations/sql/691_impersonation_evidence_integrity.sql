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
--
-- Two facts about the cluster's roles are what make this migration sound in both directions. They are stated
-- here because the next person will assume otherwise, and flipping either breaks 691 in opposite ways:
--   The DATABASE_URL login role is `postgres` with rolsuper = FALSE (Supabase's real superuser is
--   supabase_admin). A superuser would be bound by the append-only triggers too - triggers fire regardless of
--   privilege - but it can ALTER TABLE ... DISABLE TRIGGER or set session_replication_role, so "refused for
--   every role" is a statement about roles that are not superusers, and the application's role is one of them.
--   That same role has rolbypassrls = TRUE, which is why FORCE ROW LEVEL SECURITY below does not lock the
--   application out of the reads it legitimately does (loadStash, end-impersonation's audit reads).

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

-- Enabling RLS makes 675's reader depend on a property that used to be cosmetic: it can only see the evidence
-- while the role it executes as bypasses RLS. Take that away - the function loses SECURITY DEFINER, or its owner
-- loses BYPASSRLS - and the SELECT finds nothing, which the old reader reported as NULL. resolveImpersonatingActor
-- reads NULL as "nobody is impersonating this session", the exact opposite of what happened, while it reads an
-- absent function as unverified and fails closed. So the reader now answers the two cases differently: it returns
-- the unverified sentinel (the string IMPERSONATION_UNVERIFIED in src/lib/auth/impersonationState.ts, asserted
-- equal by the integration test) when it cannot see past RLS, and NULL only when it looked and there was nothing.
-- It returns rather than raising: this runs inside withAuth's transaction, where an exception would poison the
-- transaction and 500 the request instead of failing the review closed.
CREATE OR REPLACE FUNCTION public.impersonation_evidence_visible() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
$$;
ALTER FUNCTION public.impersonation_evidence_visible() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.impersonation_evidence_visible() FROM PUBLIC;
-- migration_admin because the readers are SECURITY DEFINER and run as their owner; app_user because a reader
-- that has LOST security definer is evaluated as the tenant role, where a missing grant would raise inside the
-- request transaction instead of returning the sentinel.
GRANT EXECUTE ON FUNCTION public.impersonation_evidence_visible() TO app_user, platform_admin, migration_admin;

DROP FUNCTION IF EXISTS public.control_session_impersonator();
CREATE FUNCTION public.control_session_impersonator()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
  SELECT CASE WHEN NOT public.impersonation_evidence_visible() THEN 'impersonation-state-unverified' ELSE
    (SELECT l.admin_user_id::text FROM public.admin_audit_log l
      WHERE l.action='impersonation_start' AND l.target_type='user'
        AND l.target_id::text=auth.uid()
        AND l.details->>'target_session_id'=
          (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')
      ORDER BY l.created_at DESC LIMIT 1) END
$$;
ALTER FUNCTION public.control_session_impersonator() OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.control_session_impersonator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.control_session_impersonator() TO app_user,platform_admin;

-- 677's liveness function needs no sentinel: it returns boolean, and a reader that cannot see the stash returns
-- false, which refuses the delegation proof. That is already the closed direction. The deploy gate
-- (assertImpersonationReaderDeployed) is what keeps a blinded reader off a live database for both functions.
