-- scripts/migrations/sql/355_admin_impersonation_stash.sql
-- Phase 3c: Server-side stash of the admin's tokens during impersonation, so
-- "Return to my session" can restore them without a re-login.
CREATE TABLE IF NOT EXISTS admin_impersonation_stash (
  stash_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id        text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_access_token   text        NOT NULL,
  admin_refresh_token  text        NOT NULL,
  target_user_id       text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_impersonation_stash_expires
  ON admin_impersonation_stash(expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE admin_impersonation_stash TO platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE admin_impersonation_stash TO postgres;
