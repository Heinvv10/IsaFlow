-- 999q: MCP upload intents — attach files to bank lines and accounting documents without base64 in the tool call.
--
-- WHAT.
--   mcp_upload_intents  one row per file an agent announced through create_upload_urls: the target (a bank line or an
--     entity-store document), the file name, mime type, declared size and sha256, and the sha256 of a one-time upload
--     token (the token itself is never stored). The agent PUTs the bytes to /api/mcp/uploads/<token>; they are staged
--     in staged_bytes until finalize_uploads verifies them (size, sha256, magic bytes), writes the real document row and
--     clears them.
--     status  pending (URL issued) | uploaded (bytes staged) | finalized (document written or found as a duplicate)
--             | refused (bytes failed verification at finalize; a new URL is needed). An expired row keeps its status
--             (the tools read it as 'expired' from expires_at).
--     created_by / created_token_jti  the user and the PAT / OAuth authorisation that asked for the url: finalize is
--     refused to any other principal, so a url leaked inside the company cannot be finalized by someone else.
--     A finalized row keeps its sha256 and result_document_id (no bytes): an entity-store target's dedup reads them.
--
-- LIFETIME. A url lasts 30 minutes; a successful PUT moves expires_at to now() + 2 hours (the finalize window). The
--   tools and the PUT route sweep every company (service pool, bounded batches): an expired row's staged bytes are
--   cleared at once, the row itself (still reading 'expired', not 'not found') is deleted 7 days after expiry.
--   Finalized rows stay. staged_bytes is STORAGE EXTERNAL: already-compressed files, read whole once.
--
-- RULES IN THE DATABASE (mcp_upload_intents_guard, BEFORE INSERT OR UPDATE, ENABLE ALWAYS; column grants).
--   - app_user INSERTs the declaration only: company_id, created_token_jti, target, document_type, file name, mime,
--     declared size, sha256, token hash. created_by is the session user (auth.uid(); never app-writable, so with no
--     session user the insert is refused by NOT NULL); status 'pending', expires_at now() + 30 min and every outcome
--     column are set by the trigger whatever was sent.
--   - app_user UPDATEs status, result_document_id, result_duplicate and refusal only, and never DELETEs. app_service
--     (the PUT route and the sweep) inherits that and adds UPDATE (staged_bytes) and DELETE.
--   - The declaration never changes. Status moves only pending -> uploaded (bytes present, hashing to sha256, not
--     expired: the trigger stamps uploaded_at and the 2-hour window), pending|uploaded -> refused (a refusal text;
--     bytes cleared), uploaded -> finalized (bytes were staged, not expired, and result_document_id is a live document
--     on the target: for a bank line an attachment of that line whose stored bytes hash to sha256, for an entity an
--     active entity-store row of that entity; bytes cleared, finalized_at stamped). Staged bytes exist only on an
--     uploaded row and always hash to its sha256; a same-status update may only clear an expired row's bytes or move
--     expires_at earlier.
--   - Accepted: created_token_jti is what app_user sent (no GUC carries the token id), so a raw-SQL app_user can
--     bind its OWN row to any token id; the row is still its own (created_by is stamped). And an entity row of the
--     target that is not these bytes can be named as the result (the entity store keeps no hash), which only
--     makes that raw-SQL user's later upload of those bytes to that entity read as a duplicate of it.
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930).
--
-- TENANCY. tenant_isolation for app_user (the MCP tools run under withBearerAuth's company GUCs). The PUT route has no
--   user (the token is its only credential) and runs on the service pool through 915's app_service mirrors; every
--   statement it issues about its row names the row's id AND company_id. The sweep is the one cross-company statement:
--   it touches only rows past their expiry (clears bytes, deletes after 7 days) and returns nothing.
--
-- OLD COLOUR. Nothing old reads or writes the table.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TABLE IF EXISTS public.mcp_upload_intents;
--   DROP FUNCTION IF EXISTS public.mcp_upload_intents_guard();
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.mcp_upload_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The session's user; mcp_upload_intents_guard overwrites anything sent.
  created_by TEXT NOT NULL DEFAULT auth.uid(),
  created_token_jti TEXT CHECK (char_length(created_token_jti) <= 200),
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
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  CONSTRAINT mcp_upload_intents_staged_size CHECK (staged_bytes IS NULL OR octet_length(staged_bytes) = declared_size),
  CONSTRAINT mcp_upload_intents_finalized_result CHECK (status <> 'finalized' OR result_document_id IS NOT NULL)
);
-- Already-compressed files (PDF, PNG, JPEG, OOXML), written once and read whole once: no pglz pass on either side.
ALTER TABLE public.mcp_upload_intents ALTER COLUMN staged_bytes SET STORAGE EXTERNAL;

CREATE UNIQUE INDEX IF NOT EXISTS mcp_upload_intents_token_uq ON public.mcp_upload_intents (token_hash);
CREATE INDEX IF NOT EXISTS mcp_upload_intents_target_sha_idx
  ON public.mcp_upload_intents (company_id, target_kind, target_id, sha256) WHERE status = 'finalized';
-- The per-company cap at create: outstanding (pending / uploaded, unexpired) rows and their declared bytes.
CREATE INDEX IF NOT EXISTS mcp_upload_intents_outstanding_idx
  ON public.mcp_upload_intents (company_id, expires_at) WHERE status IN ('pending', 'uploaded');
-- The global sweep: expired rows still holding bytes, and unfinalized rows a week past expiry.
CREATE INDEX IF NOT EXISTS mcp_upload_intents_staged_expiry_idx
  ON public.mcp_upload_intents (expires_at) WHERE staged_bytes IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_upload_intents_unfinalized_expiry_idx
  ON public.mcp_upload_intents (expires_at) WHERE status <> 'finalized';

COMMENT ON TABLE public.mcp_upload_intents IS
  '999q: files announced by the MCP create_upload_urls tool, staged by PUT /api/mcp/uploads/<token>, written by finalize_uploads.';

CREATE OR REPLACE FUNCTION public.mcp_upload_intents_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    NEW.status := 'pending';
    NEW.staged_bytes := NULL;
    NEW.result_document_id := NULL;
    NEW.result_duplicate := NULL;
    NEW.refusal := NULL;
    NEW.expires_at := now() + interval '30 minutes';
    NEW.created_at := now();
    NEW.uploaded_at := NULL;
    NEW.finalized_at := NULL;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.company_id, NEW.created_by, NEW.created_token_jti, NEW.target_kind, NEW.target_id, NEW.document_type,
      NEW.file_name, NEW.mime_type, NEW.declared_size, NEW.sha256, NEW.token_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.created_by, OLD.created_token_jti, OLD.target_kind, OLD.target_id, OLD.document_type,
      OLD.file_name, OLD.mime_type, OLD.declared_size, OLD.sha256, OLD.token_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'an upload intent''s declaration never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at > OLD.expires_at AND NOT (OLD.status = 'pending' AND NEW.status = 'uploaded') THEN
    RAISE EXCEPTION 'an upload intent''s expiry only moves earlier' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = OLD.status THEN
    IF (NEW.result_document_id, NEW.result_duplicate, NEW.refusal, NEW.uploaded_at, NEW.finalized_at)
       IS DISTINCT FROM (OLD.result_document_id, OLD.result_duplicate, OLD.refusal, OLD.uploaded_at, OLD.finalized_at) THEN
      RAISE EXCEPTION 'an upload intent''s outcome changes only with its status' USING ERRCODE = '23514';
    END IF;
    IF NEW.staged_bytes IS NOT NULL AND OLD.staged_bytes IS NULL THEN
      RAISE EXCEPTION 'an upload intent''s bytes are staged only by its upload' USING ERRCODE = '23514';
    END IF;
    IF NEW.staged_bytes IS NULL AND OLD.staged_bytes IS NOT NULL AND OLD.expires_at > now() THEN
      RAISE EXCEPTION 'an upload intent''s bytes are cleared only once it has expired' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'pending' AND NEW.status = 'uploaded' THEN
    IF NEW.staged_bytes IS NULL OR OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'an upload intent is uploaded only with its bytes, before it expires' USING ERRCODE = '23514';
    END IF;
    NEW.uploaded_at := now();
    NEW.expires_at := now() + interval '2 hours';
    NEW.result_document_id := NULL;
    NEW.result_duplicate := NULL;
    NEW.refusal := NULL;
  ELSIF OLD.status IN ('pending', 'uploaded') AND NEW.status = 'refused' THEN
    IF NEW.refusal IS NULL THEN
      RAISE EXCEPTION 'a refused upload intent says why' USING ERRCODE = '23514';
    END IF;
    NEW.staged_bytes := NULL;
    NEW.result_document_id := NULL;
    NEW.result_duplicate := NULL;
  ELSIF OLD.status = 'uploaded' AND NEW.status = 'finalized' THEN
    IF OLD.staged_bytes IS NULL OR OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'an upload intent is finalized only from staged, unexpired bytes' USING ERRCODE = '23514';
    END IF;
    IF OLD.target_kind = 'bank_transaction' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.bank_transaction_attachments a
          JOIN public.bank_transactions bt ON bt.id = a.bank_transaction_id
         WHERE a.id = NEW.result_document_id AND a.bank_transaction_id = OLD.target_id AND bt.company_id = OLD.company_id
           AND a.file_url ~ '^data:[^,]*;base64,[A-Za-z0-9+/=]*$'
           AND encode(sha256(decode(substring(a.file_url FROM position(',' IN a.file_url) + 1), 'base64')), 'hex') = OLD.sha256)
      THEN
        RAISE EXCEPTION 'an upload intent is finalized only to an attachment of its line holding its bytes' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.procurement_documents pd
       WHERE pd.id = NEW.result_document_id AND pd.entity_type = OLD.target_kind AND pd.entity_id = OLD.target_id
         AND pd.is_active = true)
    THEN
      RAISE EXCEPTION 'an upload intent is finalized only to an active document of its target' USING ERRCODE = '23514';
    END IF;
    NEW.staged_bytes := NULL;
    NEW.refusal := NULL;
    NEW.result_duplicate := COALESCE(NEW.result_duplicate, false);
    NEW.finalized_at := now();
  ELSE
    RAISE EXCEPTION 'an upload intent cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  IF NEW.staged_bytes IS NOT NULL
     AND (NEW.status <> 'uploaded' OR encode(sha256(NEW.staged_bytes), 'hex') <> NEW.sha256) THEN
    RAISE EXCEPTION 'an upload intent''s staged bytes hash to its declared sha256' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_mcp_upload_intents_guard ON public.mcp_upload_intents;
CREATE TRIGGER trg_mcp_upload_intents_guard BEFORE INSERT OR UPDATE ON public.mcp_upload_intents
  FOR EACH ROW EXECUTE FUNCTION public.mcp_upload_intents_guard();
ALTER TABLE public.mcp_upload_intents ENABLE ALWAYS TRIGGER trg_mcp_upload_intents_guard;
REVOKE ALL ON FUNCTION public.mcp_upload_intents_guard() FROM PUBLIC;

ALTER TABLE public.mcp_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_upload_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.mcp_upload_intents;
CREATE POLICY tenant_isolation ON public.mcp_upload_intents FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- 348's default privileges gave app_user every command: take back all but SELECT, then grant per column.
REVOKE INSERT, UPDATE, DELETE ON public.mcp_upload_intents FROM app_user;
GRANT SELECT ON public.mcp_upload_intents TO app_user;
GRANT INSERT (company_id, created_token_jti, target_kind, target_id, document_type, file_name, mime_type, declared_size,
  sha256, token_hash) ON public.mcp_upload_intents TO app_user;
GRANT UPDATE (status, result_document_id, result_duplicate, refusal) ON public.mcp_upload_intents TO app_user;
-- app_service inherits app_user's grants (915); the PUT route stages bytes and the sweep clears and deletes expired rows.
GRANT UPDATE (staged_bytes) ON public.mcp_upload_intents TO app_service;
GRANT DELETE ON public.mcp_upload_intents TO app_service;

SELECT public.app_service_sync_policies();
