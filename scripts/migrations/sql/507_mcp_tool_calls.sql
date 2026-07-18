-- Migration 507: MCP tool-call audit + idempotency table
-- (MCP Connector Phase 2. Plan numbered this 506; renumbered — 506 was taken
--  by oauth_dynamic_clients at execution time.)
--
-- Every tools/call through /api/mcp is recorded here with the token identity
-- (jti = PAT id or OAuth authorisation id) for audit. Write tools carry an
-- idempotency_key; the partial unique index makes replays single-shot per
-- (company, tool, key) and findIdempotentReplay returns the stored result.

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  user_id text NOT NULL,
  token_jti text,
  oauth_app_id uuid,
  tool text NOT NULL,
  args_hash text NOT NULL,
  idempotency_key text,
  status text NOT NULL CHECK (status IN ('ok', 'error', 'rejected')),
  result jsonb,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_tool_calls_idem_uq
  ON mcp_tool_calls (company_id, tool, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS mcp_tool_calls_company_created_idx
  ON mcp_tool_calls (company_id, created_at DESC);

-- Tenant isolation — mirror the mig 442/498 idiom (helpers from mig 348).
-- Audit rows are append-only from the app: no UPDATE/DELETE grant.
ALTER TABLE mcp_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_calls FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON mcp_tool_calls;
CREATE POLICY tenant_isolation ON mcp_tool_calls
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT ON mcp_tool_calls TO app_user;
