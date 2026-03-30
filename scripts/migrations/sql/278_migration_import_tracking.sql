-- Migration 278: Track which external system imported GL accounts
-- Used by Xero / QuickBooks / Pastel migration rollback

ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS imported_from VARCHAR(20) NULL;

CREATE INDEX IF NOT EXISTS idx_gl_accounts_imported_from
  ON gl_accounts(company_id, imported_from)
  WHERE imported_from IS NOT NULL;
