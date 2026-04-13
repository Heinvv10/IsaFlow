-- Migration 324: Password reset tokens
-- Stores hashed reset tokens so plaintext never hits the DB.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hashed_token TEXT         NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ  NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hashed
  ON password_reset_tokens (hashed_token)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens (user_id);
