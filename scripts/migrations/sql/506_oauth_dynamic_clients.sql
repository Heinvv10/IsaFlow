-- Migration 506: Dynamic OAuth clients (RFC 7591) + mcp_connector feature flag
-- (MCP Connector Phase 1. Plan numbered this 507; renumbered to the next unused
--  prefix at execution time — 505 was latest on master.)
--
-- 1. Public-client support on oauth_apps: RFC 7591 dynamic registration creates
--    PUBLIC clients (token_endpoint_auth_method 'none', PKCE-only) with no
--    client secret and no authenticated owner. Migration 469 made
--    client_secret_hash / client_secret_prefix / owner_user_id NOT NULL —
--    relax all three. Confidential-client code paths are unaffected:
--    getOauthAppByClientId derives is_confidential from
--    client_secret_hash IS NOT NULL, and verifyClientSecret fails closed on a
--    NULL hash.
-- 2. mcp_connector feature flag: dark by default (is_global = false, attached
--    to no plan) — hasFeature() returns false for every company until a
--    company_feature_overrides row enables a pilot (SARS-ISV pattern).

-- ── Public / dynamic client columns ─────────────────────────────────────────
ALTER TABLE oauth_apps ALTER COLUMN client_secret_hash DROP NOT NULL;
ALTER TABLE oauth_apps ALTER COLUMN client_secret_prefix DROP NOT NULL;
ALTER TABLE oauth_apps ALTER COLUMN owner_user_id DROP NOT NULL;

ALTER TABLE oauth_apps ADD COLUMN IF NOT EXISTS is_dynamic BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE oauth_apps ADD COLUMN IF NOT EXISTS token_endpoint_auth_method TEXT NOT NULL DEFAULT 'client_secret_post';

-- Guard the auth-method vocabulary (public 'none' vs confidential secret-post).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_apps_token_endpoint_auth_method_chk'
  ) THEN
    ALTER TABLE oauth_apps ADD CONSTRAINT oauth_apps_token_endpoint_auth_method_chk
      CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic'));
  END IF;
END $$;

-- Registration flooding cleanup / admin listing hot path — tiny partial index.
CREATE INDEX IF NOT EXISTS oauth_apps_is_dynamic_idx
  ON oauth_apps (is_dynamic, created_at DESC)
  WHERE is_dynamic;

-- ── mcp_connector feature flag (dark: override-only enablement) ─────────────
INSERT INTO feature_flags (code, name, description, is_global)
VALUES (
  'mcp_connector',
  'MCP Connector (AI agents)',
  'Hosted MCP server access for Claude/Codex agents via OAuth or PAT. Dark by default; enable per pilot company via override.',
  false
)
ON CONFLICT (code) DO NOTHING;
