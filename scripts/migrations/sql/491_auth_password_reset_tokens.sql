-- Migration 491: self-owned single-use password reset tokens (GoTrue-keyed)
--
-- Replaces GoTrue's /recover flow for password resets. GoTrue cannot
-- distinguish a recovery session from a magiclink/impersonation session
-- (both surface as amr:otp and verify interchangeably), so a GoTrue-issued
-- credential is too broad to gate a password change. These tokens are minted
-- ONLY by /api/auth/forgot-password and consumed ONLY by do-reset-password —
-- nothing else can drive a reset.
--
-- NOTE: distinct from the legacy `password_reset_tokens` (migration 324, the
-- pre-GoTrue flow, FK'd to the app `users` table). This table is keyed by the
-- GoTrue user id (auth.users.id) — which lives in a SEPARATE database from the
-- app schema, so no FK is possible or desired. The raw token is never stored;
-- we persist sha256(token) so a read of this table cannot reset an account. No
-- email/PII is kept — user_id alone identifies the account (least-data).

CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL,            -- GoTrue (auth.users) id; cross-DB, no FK
  token_hash  text        NOT NULL UNIQUE,     -- sha256(raw token), hex
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_password_reset_tokens_hash
  ON auth_password_reset_tokens(token_hash)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_password_reset_tokens_user
  ON auth_password_reset_tokens(user_id);
