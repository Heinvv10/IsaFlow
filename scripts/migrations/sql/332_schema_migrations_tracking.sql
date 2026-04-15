-- 332_schema_migrations_tracking.sql
-- Tracks which numbered migrations have been applied, so
-- scripts/apply-migrations.ts can be idempotent and detect
-- post-apply edits via checksum.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations(applied_at DESC);
