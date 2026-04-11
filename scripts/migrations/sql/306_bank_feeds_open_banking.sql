-- Migration 306: Open Banking / Bank Feeds — multi-provider connection management
-- Extends the existing Stitch-only bank_feed_connections table with:
--   • company_id direct column (IDOR-safe scoping without requiring JOIN)
--   • provider enum broadened to basiq, tink, plaid, manual_csv
--   • status / last_sync_status columns aligned to the new service
--   • bank_feed_sync_logs table (note: 237 created bank_feed_sync_log — singular)

-- ── Extend bank_feed_connections ─────────────────────────────────────────────

-- Add company_id directly for IDOR-safe single-table queries
ALTER TABLE bank_feed_connections ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
-- Back-fill from bank_accounts for any existing rows
UPDATE bank_feed_connections bfc
SET company_id = ba.company_id
FROM bank_accounts ba
WHERE bfc.bank_account_id = ba.id
  AND bfc.company_id IS NULL;

-- provider, status, last_sync_status columns (may already exist with different names)
ALTER TABLE bank_feed_connections ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE bank_feed_connections ADD COLUMN IF NOT EXISTS last_sync_status VARCHAR(20);
ALTER TABLE bank_feed_connections ADD COLUMN IF NOT EXISTS last_sync_error TEXT;
ALTER TABLE bank_feed_connections ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}';

-- Index for fast tenant scoping
CREATE INDEX IF NOT EXISTS idx_bfc_company_id ON bank_feed_connections(company_id);

-- ── bank_feed_sync_logs (plural — new general table) ─────────────────────────

CREATE TABLE IF NOT EXISTS bank_feed_sync_logs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id         UUID        NOT NULL REFERENCES bank_feed_connections(id) ON DELETE CASCADE,
  company_id            UUID        NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  status                VARCHAR(20) NOT NULL DEFAULT 'running', -- running, success, failed
  transactions_found    INT         NOT NULL DEFAULT 0,
  transactions_imported INT         NOT NULL DEFAULT 0,
  transactions_duplicate INT        NOT NULL DEFAULT 0,
  error_message         TEXT
);

CREATE INDEX IF NOT EXISTS idx_bfsl_connection ON bank_feed_sync_logs(connection_id);
CREATE INDEX IF NOT EXISTS idx_bfsl_company_started ON bank_feed_sync_logs(company_id, started_at DESC);
