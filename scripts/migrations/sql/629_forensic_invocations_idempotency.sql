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

-- An admission is durable before the financial transaction does any work. No identity FKs:
-- its independent connection must not wait on authority rows locked by that transaction.
CREATE TABLE IF NOT EXISTS mcp_invocation_attempts (
  company_id uuid NOT NULL,id uuid NOT NULL,
  person_id text NOT NULL,auth_method text NOT NULL CHECK(auth_method IN('cookie','pat','oauth')),
  grant_id text,connection_id text,request_id uuid NOT NULL,operation_id uuid NOT NULL,
  tool text NOT NULL CHECK(length(tool) BETWEEN 1 AND 128),
  args_hash text NOT NULL CHECK(args_hash ~ '^[0-9a-f]{64}$'),
  key_hash text CHECK(key_hash ~ '^[0-9a-f]{64}$'),
  outer_xid xid8 NOT NULL,admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id)
);
CREATE INDEX IF NOT EXISTS mcp_invocation_attempts_tenant_time_idx
  ON mcp_invocation_attempts(company_id,admitted_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mcp_invocation_receipts (
  company_id uuid NOT NULL,attempt_id uuid NOT NULL,outer_xid xid8 NOT NULL,
  status text NOT NULL CHECK(status IN('ok','rejected','error','replay')),
  reported_write boolean NOT NULL,
  reason_code text CHECK(reason_code ~ '^[A-Z0-9_]{1,64}$'),
  duration_ms integer NOT NULL CHECK(duration_ms>=0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,attempt_id),
  FOREIGN KEY(company_id,attempt_id) REFERENCES mcp_invocation_attempts(company_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mcp_invocation_outcomes (
  company_id uuid NOT NULL,attempt_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
  transaction_outcome text NOT NULL CHECK(transaction_outcome IN('committed','rolled_back','unknown')),
  source text NOT NULL CHECK(source IN('observer','reconciled')),
  status text CHECK(status IN('ok','rejected','error','replay')),
  reported_write boolean,reason_code text CHECK(reason_code ~ '^[A-Z0-9_]{1,64}$'),
  duration_ms integer CHECK(duration_ms>=0),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id),UNIQUE(company_id,attempt_id,transaction_outcome),
  FOREIGN KEY(company_id,attempt_id) REFERENCES mcp_invocation_attempts(company_id,id) ON DELETE CASCADE
);
ALTER TABLE mcp_invocation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_invocation_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_invocation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_invocation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_invocation_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_invocation_outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON mcp_invocation_attempts;
CREATE POLICY tenant_read ON mcp_invocation_attempts FOR SELECT USING(
  company_id=app.current_company_id() AND (person_id=auth.uid()::text OR company_id IN(SELECT auth.user_companies())));
DROP POLICY IF EXISTS authenticated_admission ON mcp_invocation_attempts;
CREATE POLICY authenticated_admission ON mcp_invocation_attempts FOR INSERT WITH CHECK(
  company_id=app.current_company_id() AND person_id=auth.uid()::text);
DROP POLICY IF EXISTS tenant_read ON mcp_invocation_receipts;
CREATE POLICY tenant_read ON mcp_invocation_receipts FOR SELECT USING(
  company_id=app.current_company_id() AND EXISTS(SELECT 1 FROM mcp_invocation_attempts a
    WHERE a.company_id=mcp_invocation_receipts.company_id AND a.id=mcp_invocation_receipts.attempt_id));
DROP POLICY IF EXISTS original_transaction ON mcp_invocation_receipts;
CREATE POLICY original_transaction ON mcp_invocation_receipts FOR INSERT WITH CHECK(
  company_id=app.current_company_id() AND outer_xid=pg_current_xact_id()
  AND EXISTS(SELECT 1 FROM mcp_invocation_attempts a WHERE a.company_id=mcp_invocation_receipts.company_id
    AND a.id=mcp_invocation_receipts.attempt_id AND a.person_id=auth.uid()::text AND a.outer_xid=mcp_invocation_receipts.outer_xid));
DROP POLICY IF EXISTS tenant_read ON mcp_invocation_outcomes;
CREATE POLICY tenant_read ON mcp_invocation_outcomes FOR SELECT USING(
  company_id=app.current_company_id() AND EXISTS(SELECT 1 FROM mcp_invocation_attempts a
    WHERE a.company_id=mcp_invocation_outcomes.company_id AND a.id=mcp_invocation_outcomes.attempt_id));
DROP POLICY IF EXISTS authenticated_outcome ON mcp_invocation_outcomes;
CREATE POLICY authenticated_outcome ON mcp_invocation_outcomes FOR INSERT WITH CHECK(
  company_id=app.current_company_id() AND EXISTS(SELECT 1 FROM mcp_invocation_attempts a
    WHERE a.company_id=mcp_invocation_outcomes.company_id AND a.id=mcp_invocation_outcomes.attempt_id
      AND (a.person_id=auth.uid()::text OR (source='reconciled' AND a.company_id IN(SELECT auth.user_companies())))));
REVOKE ALL ON mcp_invocation_attempts,mcp_invocation_receipts,mcp_invocation_outcomes FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON mcp_invocation_attempts,mcp_invocation_receipts,mcp_invocation_outcomes TO app_user;
