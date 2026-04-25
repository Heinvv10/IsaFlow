-- Migration 464: Capture API Keys
-- Company-scoped API keys for the capture module (external integrations, e.g. FibreFlow PWA)

CREATE TABLE IF NOT EXISTS capture_api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,   -- SHA-256 of the raw key
  key_prefix   TEXT NOT NULL,          -- first 16 chars of raw key, for display
  label        TEXT NOT NULL,          -- e.g. "Fiberflow integration"
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_capture_api_keys_company ON capture_api_keys(company_id);
CREATE INDEX IF NOT EXISTS idx_capture_api_keys_hash ON capture_api_keys(key_hash) WHERE is_active = true;
