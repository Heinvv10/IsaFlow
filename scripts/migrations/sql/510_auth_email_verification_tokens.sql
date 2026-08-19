-- 510: self-owned email-verification tokens for public self-serve signup.
--
-- Public registration creates the GoTrue user UNCONFIRMED and parks the company
-- details here. The tenant (company + subscription + owner membership) is only
-- provisioned when the emailed link is consumed, so an unverified address can
-- never create a company, a subscription, or an ops notification.
--
-- Only sha256(token) is stored: a read of this table cannot be replayed to
-- activate an account. Mirrors auth_password_reset_tokens (migration 491).

CREATE TABLE IF NOT EXISTS auth_email_verification_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GoTrue user id. No FK: GoTrue owns auth.users in its own schema.
  gotrue_user_id  UUID        NOT NULL,
  token_hash      TEXT        NOT NULL UNIQUE,
  -- Pending tenant details captured at signup: company name, signup type,
  -- declared turnover, contact names/phone. No credentials — the password lives
  -- in GoTrue from the moment the unconfirmed user is created.
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_email_verification_tokens_user
  ON auth_email_verification_tokens (gotrue_user_id);

-- Sweep expired/consumed rows without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_auth_email_verification_tokens_expiry
  ON auth_email_verification_tokens (expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE auth_email_verification_tokens IS
  'Single-use email-verification tokens for public signup. Tenant provisioning is deferred until one is consumed.';
