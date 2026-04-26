-- Migration 467: Personal Access Tokens (PRD-10 Layer 3)
-- User-bound API tokens for scripts, CI, and one-off automation.
-- Token format: pat_<32 base62 chars>. SHA-256 hash stored; plaintext shown once.
-- Each PAT is scoped to (user_id, company_id) — a user with access to N companies
-- mints N separate tokens, one per tenant, mirroring how OAuth authorisations
-- will be scoped in PRD-10 Layer 2.

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,           -- SHA-256 of full plaintext token
  token_prefix    TEXT NOT NULL,                  -- first 12 chars (pat_xxxxxxxx), display only
  name            TEXT NOT NULL,                  -- e.g. "Month-end automation"
  scopes          TEXT[] NOT NULL DEFAULT '{}',   -- e.g. {"read:reports","write:journals"}
  expires_at      TIMESTAMPTZ NOT NULL,           -- default NOW() + 90 days at issue time
  last_used_at    TIMESTAMPTZ,
  last_used_ip    INET,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup hot path: hash → token row, only active rows.
CREATE INDEX IF NOT EXISTS idx_pat_lookup
  ON personal_access_tokens (token_hash)
  WHERE revoked_at IS NULL;

-- List-my-tokens hot path: per (user_id, company_id), only active rows.
CREATE INDEX IF NOT EXISTS idx_pat_user_company
  ON personal_access_tokens (user_id, company_id, created_at DESC)
  WHERE revoked_at IS NULL;
