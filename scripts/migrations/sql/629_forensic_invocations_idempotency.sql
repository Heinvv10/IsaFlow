-- Root reservation 629: replay protection must outlive forensic history retention.
CREATE TABLE IF NOT EXISTS mcp_idempotency_results (
  company_id uuid NOT NULL,
  tool text NOT NULL,
  idempotency_key text NOT NULL,
  args_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,tool,idempotency_key)
);
-- Preserve every legacy successful intent before any history retention can run.
INSERT INTO mcp_idempotency_results(company_id,tool,idempotency_key,args_hash,result,created_at)
SELECT company_id,tool,idempotency_key,args_hash,COALESCE(result,'null'::jsonb),created_at
FROM mcp_tool_calls WHERE status='ok' AND idempotency_key IS NOT NULL
ON CONFLICT(company_id,tool,idempotency_key) DO NOTHING;
ALTER TABLE mcp_idempotency_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_idempotency_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_idempotency_results;
CREATE POLICY tenant_isolation ON mcp_idempotency_results FOR ALL
  USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()))
  WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
REVOKE ALL ON mcp_idempotency_results FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON mcp_idempotency_results TO app_user;
