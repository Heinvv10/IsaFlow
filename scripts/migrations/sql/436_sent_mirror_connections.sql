-- 436_sent_mirror_connections.sql
-- PRD-06 Phase 6: Outbound-channel capture (Sent-folder mirror).
--
-- Symmetric counterpart to migration 420 (imap_mirror_connections). Watches
-- the Sent folder of a connected mailbox. When an outbound email carries a
-- PDF attachment whose sha256 already exists in captured_documents for this
-- tenant (because we produced and sealed it in Phase 1), we link the mirror
-- event back to the existing invoice snapshot. Net effect: one evidence
-- row per invoice, regardless of whether it went out via the app's own
-- send pipeline or via the user's Gmail/Outlook.
--
-- Credentials, cursor, and trigger pattern mirror 420 verbatim so ops /
-- dashboards can be generalised later.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sent_mirror_connections (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider                  TEXT NOT NULL CHECK (provider IN ('gmail', 'm365', 'imap')),
  display_name              TEXT NOT NULL,
  account_email             TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disconnected', 'error')),
  last_error                TEXT,
  oauth_refresh_token_enc   TEXT,
  imap_host                 TEXT,
  imap_port                 INT,
  imap_use_tls              BOOLEAN DEFAULT TRUE,
  imap_username             TEXT,
  imap_password_enc         TEXT,
  scan_cursor               JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_folder               TEXT NOT NULL DEFAULT 'Sent',
  scan_interval_minutes     INT NOT NULL DEFAULT 10,
  last_scan_at              TIMESTAMPTZ,
  last_success_at           TIMESTAMPTZ,
  messages_captured_total   INT NOT NULL DEFAULT 0,
  messages_linked_total     INT NOT NULL DEFAULT 0,
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at           TIMESTAMPTZ,
  UNIQUE (company_id, account_email)
);

CREATE INDEX IF NOT EXISTS idx_sent_mirror_company
  ON sent_mirror_connections(company_id, status);

CREATE INDEX IF NOT EXISTS idx_sent_mirror_scan_due
  ON sent_mirror_connections(last_scan_at)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION sent_mirror_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sent_mirror_touch ON sent_mirror_connections;
CREATE TRIGGER trg_sent_mirror_touch
  BEFORE UPDATE ON sent_mirror_connections
  FOR EACH ROW EXECUTE FUNCTION sent_mirror_touch_updated_at();

-- Audit trail of per-message outcomes. Two "success" outcomes are possible:
--   'linked_to_invoice' — attachment sha matched an existing invoice snapshot
--   'captured_outbound' — no hash match; new captured_documents row created
-- Everything else is skip/error.
CREATE TABLE IF NOT EXISTS sent_mirror_scan_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id            UUID NOT NULL REFERENCES sent_mirror_connections(id) ON DELETE CASCADE,
  company_id               UUID NOT NULL,
  imap_uid                 TEXT,
  recipient                TEXT,
  subject                  TEXT,
  attachment_count         INT NOT NULL DEFAULT 0,
  outcome                  TEXT NOT NULL,
  error                    TEXT,
  linked_invoice_ids       UUID[],
  captured_document_ids    UUID[],
  scanned_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sent_mirror_log_connection
  ON sent_mirror_scan_log(connection_id, scanned_at DESC);

-- Quick lookup for "did we already see this sha for this tenant's outbound?"
-- Used by the service to mark dedup events without re-hashing.
CREATE INDEX IF NOT EXISTS idx_captured_documents_sha_company
  ON captured_documents(company_id, raw_bytes_sha256)
  WHERE raw_bytes_sha256 IS NOT NULL;
