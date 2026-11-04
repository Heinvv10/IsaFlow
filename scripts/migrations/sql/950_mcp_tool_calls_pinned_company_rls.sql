-- 950: Pin MCP tool-call audit reads to the request's active company.
--
-- A user may belong to several companies. Migration 507's read predicate used
-- auth.user_companies(), so one request could read audit rows for every one of
-- those memberships. MCP requests already set app.current_company_id before
-- any audit or idempotency query; use that request-pinned company for reads.
--
-- The WITH CHECK predicate is unchanged, so inserts remain limited to the
-- active company. app_user has no UPDATE or DELETE grant on this append-only
-- table. The MCP bearer pipeline is the only production reader; platform and
-- migration administration roles continue to bypass RLS where authorised.
--
-- ROLLBACK. Restore migration 507's policy exactly. This widens reads back to
-- every company in auth.user_companies(), so use only as an approved rollback.
-- ROLLBACK SQL BEGIN
-- DROP POLICY IF EXISTS tenant_isolation ON mcp_tool_calls;
-- CREATE POLICY tenant_isolation ON mcp_tool_calls
--   FOR ALL
--   USING (company_id IN (SELECT auth.user_companies()))
--   WITH CHECK (company_id = app.current_company_id());
-- ROLLBACK SQL END

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS tenant_isolation ON mcp_tool_calls;
CREATE POLICY tenant_isolation ON mcp_tool_calls
  FOR ALL
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
