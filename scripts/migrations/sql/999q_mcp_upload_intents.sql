-- 999q: MCP upload intents — attach files to bank lines and accounting documents without base64 in the tool call.
--
-- WHAT.
--   mcp_upload_intents  one row per file an agent announced through create_upload_urls: the target (a bank line or an
--     entity-store document), the file name, mime type, declared size and sha256, and the sha256 of a one-time upload
--     token (the token itself is never stored). The agent PUTs the bytes to /api/mcp/uploads/<token>; they are staged
--     in staged_bytes until finalize_uploads verifies them (size, sha256, magic bytes), writes the real document row and
--     clears them.
--     status  pending (URL issued) | uploaded (bytes staged) | finalized (document written or found as a duplicate)
--             | refused (bytes failed verification at finalize; a new URL is needed).
--     created_by / created_token_jti  the user and the PAT / OAuth authorisation that asked for the url: finalize is
--     refused to any other principal, so a url leaked inside the company cannot be finalized by someone else.
--     A finalized row keeps its sha256 and result_document_id (no bytes), so re-sending the same batch reports
--     duplicate: true up front. Unfinalized rows past expires_at are purged by the tools (bounded DELETE per call).
--
-- TENANCY. tenant_isolation for app_user (the MCP tools run under withBearerAuth's company GUCs). The PUT route has no
--   user (the token is its only credential) and runs on the service pool through 915's app_service mirrors; every
--   statement it issues names the row's id AND company_id.
--
-- OLD COLOUR. Nothing old reads or writes the table.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TABLE IF EXISTS public.mcp_upload_intents;
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.mcp_upload_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_token_jti TEXT,
  target_kind TEXT NOT NULL CHECK (target_kind IN (
    'bank_transaction', 'supplier_invoice', 'customer_invoice', 'credit_note', 'supplier_payment', 'customer_payment')),
  target_id UUID NOT NULL,
  document_type TEXT CHECK (char_length(document_type) <= 50),
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  mime_type TEXT NOT NULL CHECK (char_length(mime_type) <= 100),
  declared_size INTEGER NOT NULL CHECK (declared_size > 0 AND declared_size <= 10485760),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  staged_bytes BYTEA,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'finalized', 'refused')),
  result_document_id UUID,
  result_duplicate BOOLEAN,
  refusal TEXT CHECK (char_length(refusal) <= 300),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  CONSTRAINT mcp_upload_intents_staged_size CHECK (staged_bytes IS NULL OR octet_length(staged_bytes) = declared_size),
  CONSTRAINT mcp_upload_intents_finalized_result CHECK (status <> 'finalized' OR result_document_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_upload_intents_token_uq ON public.mcp_upload_intents (token_hash);
CREATE INDEX IF NOT EXISTS mcp_upload_intents_target_sha_idx
  ON public.mcp_upload_intents (company_id, target_kind, target_id, sha256) WHERE status = 'finalized';
CREATE INDEX IF NOT EXISTS mcp_upload_intents_expiry_idx
  ON public.mcp_upload_intents (company_id, expires_at) WHERE status <> 'finalized';

COMMENT ON TABLE public.mcp_upload_intents IS
  '999q: files announced by the MCP create_upload_urls tool, staged by PUT /api/mcp/uploads/<token>, written by finalize_uploads.';

ALTER TABLE public.mcp_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_upload_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.mcp_upload_intents;
CREATE POLICY tenant_isolation ON public.mcp_upload_intents FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

SELECT public.app_service_sync_policies();
