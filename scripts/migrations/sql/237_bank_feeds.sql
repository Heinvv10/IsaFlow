-- Bank Feeds — Stitch.money integration
-- Stores linked bank connections, OAuth tokens, and sync state

CREATE TABLE IF NOT EXISTS bank_feed_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL, -- FK to bank_accounts
  provider TEXT NOT NULL DEFAULT 'stitch', -- stitch, investec, manual
  external_account_id TEXT, -- Stitch's account ID
  bank_name TEXT,
  account_number_masked TEXT,
  branch_code TEXT,
  account_type TEXT,
  access_token TEXT, -- encrypted in production
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_sync_cursor TEXT, -- pagination cursor for incremental sync
  sync_status TEXT DEFAULT 'pending', -- pending, syncing, synced, error
  sync_error TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_feed_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES bank_feed_connections(id) ON DELETE CASCADE,
  sync_type TEXT NOT NULL DEFAULT 'incremental', -- full, incremental
  transactions_fetched INTEGER DEFAULT 0,
  transactions_imported INTEGER DEFAULT 0,
  transactions_skipped INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'running', -- running, completed, failed
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_bank_feed_connections_account ON bank_feed_connections(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_feed_connections_provider ON bank_feed_connections(provider);
CREATE INDEX IF NOT EXISTS idx_bank_feed_sync_log_connection ON bank_feed_sync_log(connection_id);
