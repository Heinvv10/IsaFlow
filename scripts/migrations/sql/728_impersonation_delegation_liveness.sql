-- DEPLOY NOTE - renumbered 2026-09-14 from 677_impersonation_delegation_liveness.sql (see the dated exception
-- in scripts/migrations/README.md). This file was ALSO edited after it had been applied, and an earlier version
-- of this note told the deployer to clear a checksum conflict alongside 726's. That instruction is now wrong and
-- has been removed: apply-migrations.ts tracks migrations by FILENAME, so a database that applied the OLD name
-- has no row for this one. It raises no checksum conflict, it applies this file IN FULL as a new migration, and
-- `bun scripts/migrations/resolve-checksum-conflicts.ts` would find nothing to resolve. Do not run it here - a
-- command that does nothing reads as a step that succeeded.
--
-- That re-application is safe. The only edit was pinning pg_temp LAST in this function's search_path; the file is
-- idempotent by construction (CREATE INDEX IF NOT EXISTS, DROP then CREATE FUNCTION) and is the sole definition
-- of that function. Measured alongside the other 40 renumbered files: all 41 applied twice, in prefix order, to a
-- copy of the synthetic fixture that already carried them - 41 of 41 in both passes, no schema change on the second.
--
-- Why the pin: a search_path that does not name pg_temp puts it FIRST, and it is searched there for TYPES as
-- well as relations. Every relation here is schema-qualified, but the casts are not shadow-proof by
-- qualification alone - proved on the fixture, as app_user, with CREATE TYPE pg_temp.text AS (x int): this
-- function then raises 'operator does not exist: text = pg_catalog.text' on target_id::text. Worse than a
-- single failed call, because a temp type survives COMMIT and belongs to the SESSION: created on a pooled
-- connection, it poisons that connection's later liveness calls on the DATABASE_URL login role, so every
-- delegation proof is refused until the connection is recycled. Fail-closed, but a tenant-triggerable denial
-- of the impersonation path. Naming pg_temp last pins it behind pg_catalog and closes it.
--
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
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
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
