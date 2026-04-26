-- Migration 470: PRD-10 Layer 2 review fixes (RLS + nullable refresh hash)
--
-- 1. Enable RLS on oauth_authorisation_codes (asymmetry with mig 468 PAT RLS)
-- 2. Make refresh_token_hash nullable so we can OMIT it when offline_access
--    isn't granted, instead of orphan-storing a hash the client never saw.
-- 3. Track previous_refresh_token_hash so refresh-replay detection can revoke
--    the entire authorisation row (PRD §10).

-- ── RLS on authorisation codes ──────────────────────────────────────────────
ALTER TABLE oauth_authorisation_codes ENABLE ROW LEVEL SECURITY;

-- Owner-only — codes are short-lived but still user-bound. Token-exchange
-- runs on the privileged default pool and bypasses RLS, same as PAT validation.
CREATE POLICY oauth_codes_owner ON oauth_authorisation_codes
  FOR ALL TO app_user
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── Make refresh_token_hash nullable + add previous_refresh_token_hash ─────
ALTER TABLE oauth_authorisations
  ALTER COLUMN refresh_token_hash DROP NOT NULL;

ALTER TABLE oauth_authorisations
  ALTER COLUMN refresh_token_expires_at DROP NOT NULL;

ALTER TABLE oauth_authorisations
  ADD COLUMN IF NOT EXISTS previous_refresh_token_hash TEXT;

-- Index the previous-hash column so replay lookups (presented hash matches an
-- old, rotated-out value) are fast — partial to keep it tiny.
CREATE INDEX IF NOT EXISTS idx_oauth_auth_prev_refresh
  ON oauth_authorisations (previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL AND revoked_at IS NULL;
