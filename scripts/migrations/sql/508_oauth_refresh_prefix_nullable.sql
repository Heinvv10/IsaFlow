-- Migration 508: make oauth_authorisations.refresh_token_prefix nullable
--
-- Completes the intent of migration 470 ("Make refresh_token_hash nullable so
-- we can OMIT it when offline_access isn't granted"). 470 dropped NOT NULL on
-- refresh_token_hash and refresh_token_expires_at but MISSED refresh_token_prefix,
-- which stayed NOT NULL from the original 469 schema.
--
-- issueTokens() (src/lib/auth/oauth.ts) only mints a refresh token when the
-- offline_access scope is granted; otherwise it inserts NULL for every refresh
-- column. With refresh_token_prefix still NOT NULL, any auth-code exchange that
-- did NOT request offline_access hit a 500 (not-null violation) AFTER the atomic
-- consume UPDATE had already burned the code — breaking the entire browser OAuth
-- flow for standard (non-offline) clients. PATs bypass issueTokens, so this was
-- invisible until a real oauth/token exchange.
--
-- Idempotent: DROP NOT NULL on an already-nullable column is a no-op.

ALTER TABLE oauth_authorisations
  ALTER COLUMN refresh_token_prefix DROP NOT NULL;
