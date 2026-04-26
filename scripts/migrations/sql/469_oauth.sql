-- Migration 469: OAuth 2.0 (PRD-10 Layer 2)
-- Standard auth-code flow with PKCE. Opaque access + refresh tokens (instant
-- revocation, mirrors PAT pattern from mig 467). Single-use refresh tokens
-- detect replay and revoke the authorisation row.

CREATE TABLE IF NOT EXISTS oauth_apps (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  description         TEXT,
  logo_url            TEXT,
  homepage_url        TEXT,
  redirect_uris       TEXT[] NOT NULL CHECK (array_length(redirect_uris, 1) >= 1),
  client_id           TEXT NOT NULL UNIQUE,
  client_secret_hash  TEXT NOT NULL,
  client_secret_prefix TEXT NOT NULL,
  owner_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  is_first_party      BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_apps_owner
  ON oauth_apps (owner_user_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE oauth_apps ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_apps_owner ON oauth_apps
  FOR ALL TO app_user
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

CREATE TABLE IF NOT EXISTS oauth_authorisation_codes (
  code_hash             TEXT PRIMARY KEY,
  oauth_app_id          UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  scopes                TEXT[] NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry
  ON oauth_authorisation_codes (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_authorisations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_app_id             UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id               UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scopes                   TEXT[] NOT NULL,
  access_token_hash        TEXT,
  access_token_prefix      TEXT,
  access_token_expires_at  TIMESTAMPTZ,
  refresh_token_hash       TEXT NOT NULL,
  refresh_token_prefix     TEXT NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  last_used_at             TIMESTAMPTZ,
  last_used_ip             INET,
  revoked_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (oauth_app_id, user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_auth_access
  ON oauth_authorisations (access_token_hash)
  WHERE revoked_at IS NULL AND access_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_auth_refresh
  ON oauth_authorisations (refresh_token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_auth_user
  ON oauth_authorisations (user_id, company_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE oauth_authorisations ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_authorisations_owner ON oauth_authorisations
  FOR ALL TO app_user
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
