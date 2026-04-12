-- Migration 316: Add metadata column to user_sessions
-- Supports storing impersonation context (impersonated_by, etc.)

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;

COMMENT ON COLUMN user_sessions.metadata IS 'Optional JSON metadata, e.g. { "impersonated_by": "<admin_user_id>" }';

CREATE INDEX IF NOT EXISTS idx_user_sessions_metadata_gin
  ON user_sessions USING gin (metadata)
  WHERE metadata IS NOT NULL;
