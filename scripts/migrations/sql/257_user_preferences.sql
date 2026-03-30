-- Migration 257: User preferences table and mobile column on users
-- Stores per-user UI preferences (rows per page, theme, nav mode, etc.)

CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_prefs_user ON user_preferences(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile VARCHAR(50);
