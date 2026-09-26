-- scripts/migrations/sql/709_impersonation_sessions.sql
-- R-032: approval decisions are refused while the session is an impersonation.
--
-- "Login as" (pages/api/admin/users/[id]/impersonate.ts) hands the platform
-- admin a genuine GoTrue session for the target, so at request time nothing
-- the server trusts says who is really acting. The proof and stash cookies do
-- mark the session, but they are ordinary cookies: the admin can delete them
-- and the target session keeps working. The stash row is no better — it is
-- deleted on end-impersonation and expires after an hour, while the target's
-- GoTrue session is not revoked and can still be refreshed.
--
-- So the impersonation route records the minted session's GoTrue `session_id`
-- here BEFORE any cookie is issued. A session id is never reused and survives
-- token refresh, and rows are never deleted: a session recorded once is an
-- impersonation session for as long as it can authenticate.
--
-- app_user may read only the row of the session its own transaction is
-- authenticated as (withAuth's `request.jwt.claims`), which answers "is this
-- request an impersonation?" and nothing about anybody else's sessions.

CREATE TABLE IF NOT EXISTS impersonation_sessions (
  session_id     TEXT PRIMARY KEY,
  actor_user_id  TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impersonation_sessions_own_session ON impersonation_sessions;
CREATE POLICY impersonation_sessions_own_session ON impersonation_sessions
  FOR SELECT TO app_user
  USING (session_id = NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id');

-- Default privileges (migrations 348/352) grant app_user and platform_admin
-- INSERT/UPDATE/DELETE on every new table. A tenant session must not write a
-- record, and nobody may alter or remove one once written.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE impersonation_sessions FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE impersonation_sessions FROM platform_admin;
GRANT SELECT ON TABLE impersonation_sessions TO app_user;
GRANT SELECT, INSERT ON TABLE impersonation_sessions TO platform_admin;
