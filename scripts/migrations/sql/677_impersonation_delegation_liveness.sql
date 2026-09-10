-- A delegation proof is honoured only while its stash row lives and no end has been
-- recorded for the session it names. Both reads live behind one SECURITY DEFINER
-- function: the request path must not need SELECT on admin_impersonation_stash (which
-- holds the administrator's encrypted tokens). It is called from verifyToken on the
-- DATABASE_URL login role, before any app_user transaction; if that role cannot execute
-- it, the proof is refused and logged (fail closed), which the deploy gate prevents.
--
-- The audit lookup is by an expression, so it gets its own partial index: admin_audit_log
-- grows forever and this runs on every proof-carrying request.
CREATE INDEX IF NOT EXISTS idx_admin_audit_impersonation_session
  ON admin_audit_log ((details->>'target_session_id'))
  WHERE action IN ('impersonation_start','impersonation_end','impersonation_end_failed');

DROP FUNCTION IF EXISTS public.impersonation_delegation_live(uuid,text,text,text);
CREATE FUNCTION public.impersonation_delegation_live(p_stash uuid,p_actor text,p_target text,p_session text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.admin_impersonation_stash
      WHERE stash_id=p_stash AND admin_user_id=p_actor AND target_user_id=p_target
        AND expires_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM public.admin_audit_log
      WHERE action IN('impersonation_end','impersonation_end_failed') AND target_type='user'
        AND target_id::text=p_target AND details->>'target_session_id'=p_session)
$$;
ALTER FUNCTION public.impersonation_delegation_live(uuid,text,text,text) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.impersonation_delegation_live(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.impersonation_delegation_live(uuid,text,text,text) TO app_user,platform_admin;
