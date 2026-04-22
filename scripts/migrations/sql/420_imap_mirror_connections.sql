-- 420_imap_mirror_connections.sql
-- PRD-05 Phase 9: Mirror inbox (IMAP / Gmail / M365).
--
-- Per-company connections to external email inboxes. Credentials are stored
-- encrypted at rest via pgcrypto (app_secret GUC); IMAP password + OAuth
-- refresh token are the only sensitive fields. Access tokens are not stored
-- — they're derived from the refresh token on demand and held in memory.
--
-- Scanning: cron-triggered service walks the UID cursor forward, filters for
-- invoice-shaped attachments, and drops them into the existing capture
-- pipeline (captureRouterService → VLM → ai-invoice-pipeline).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS imap_mirror_connections (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider                  TEXT NOT NULL CHECK (provider IN ('gmail', 'm365', 'imap')),
  display_name              TEXT NOT NULL,                       -- "Finance Inbox (billing@)"
  account_email             TEXT NOT NULL,                       -- the mailbox address we poll
  status                    TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disconnected', 'error')),
  last_error                TEXT,
  -- Provider-specific creds (encrypted). One of these will be populated.
  oauth_refresh_token_enc   TEXT,                                -- Gmail / M365
  imap_host                 TEXT,                                -- generic IMAP only
  imap_port                 INT,
  imap_use_tls              BOOLEAN DEFAULT TRUE,
  imap_username             TEXT,
  imap_password_enc         TEXT,
  -- Scan cursor (store the highest UID seen per folder as JSON)
  scan_cursor               JSONB NOT NULL DEFAULT '{}'::jsonb,
  folder                    TEXT NOT NULL DEFAULT 'INBOX',
  -- Allow/deny lists: arrays of email addresses or domains
  allowed_senders           TEXT[] NOT NULL DEFAULT '{}',
  denied_senders            TEXT[] NOT NULL DEFAULT '{}',
  -- Scan pacing + telemetry
  scan_interval_minutes     INT NOT NULL DEFAULT 5,
  last_scan_at              TIMESTAMPTZ,
  last_success_at           TIMESTAMPTZ,
  messages_ingested_total   INT NOT NULL DEFAULT 0,
  created_by                TEXT,                                -- users.id is TEXT in this schema
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at           TIMESTAMPTZ,
  UNIQUE (company_id, account_email)
);

CREATE INDEX IF NOT EXISTS idx_imap_mirror_company
  ON imap_mirror_connections(company_id, status);

CREATE INDEX IF NOT EXISTS idx_imap_mirror_scan_due
  ON imap_mirror_connections(last_scan_at)
  WHERE status = 'active';

-- Keep updated_at fresh on every row update
CREATE OR REPLACE FUNCTION imap_mirror_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imap_mirror_touch ON imap_mirror_connections;
CREATE TRIGGER trg_imap_mirror_touch
  BEFORE UPDATE ON imap_mirror_connections
  FOR EACH ROW EXECUTE FUNCTION imap_mirror_touch_updated_at();

-- Audit trail of per-message ingestion outcomes (for debugging + compliance)
CREATE TABLE IF NOT EXISTS imap_mirror_scan_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id       UUID NOT NULL REFERENCES imap_mirror_connections(id) ON DELETE CASCADE,
  company_id          UUID NOT NULL,
  imap_uid            TEXT,                    -- provider UID / message-id
  sender              TEXT,
  subject             TEXT,
  attachment_count    INT NOT NULL DEFAULT 0,
  outcome             TEXT NOT NULL,           -- 'ingested' | 'skipped_no_attachment' | 'denied_sender' | 'skipped_not_invoice' | 'error'
  error               TEXT,
  capture_event_ids   UUID[],
  scanned_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_imap_mirror_log_connection
  ON imap_mirror_scan_log(connection_id, scanned_at DESC);
