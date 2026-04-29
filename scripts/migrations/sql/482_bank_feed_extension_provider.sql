-- Migration 482: Bank-feed extension provider columns
--
-- Adds support for the browser-extension bank scraper (provider = 'extension').
-- The provider column is plain TEXT (no CHECK constraint), so no enum widening
-- is needed — we only add scraper-version tracking columns and a unique pairing
-- index used by the extension-pair → extension-ingest flow.

-- Track which scraper version produced the most recent batch.
ALTER TABLE bank_feed_connections
  ADD COLUMN IF NOT EXISTS scraper_version TEXT,
  ADD COLUMN IF NOT EXISTS last_scraper_version TEXT;

-- Optional per-connection daily transaction cap (anti-abuse for extension provider).
-- NULL = use global default (500/day).
ALTER TABLE bank_feed_connections
  ADD COLUMN IF NOT EXISTS daily_tx_cap INT;

-- Fast lookup by (company_id, provider) for the extension UI.
CREATE INDEX IF NOT EXISTS idx_bfc_company_provider
  ON bank_feed_connections (company_id, provider);
