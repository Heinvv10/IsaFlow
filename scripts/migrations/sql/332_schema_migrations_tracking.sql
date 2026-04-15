-- 332_schema_migrations_tracking.sql
-- Tracks which migrations have been applied, so scripts/apply-migrations.ts
-- can be idempotent and detect post-apply edits via checksum.
--
-- Identity = filename (name). Version is a text field used only for
-- sort ordering. Historical repo contains 9 cases where two different
-- migration files share the same numeric prefix (e.g. both
-- 245_inventory.sql and 245_company_settings.sql exist); version is
-- therefore NOT unique, filename is.
--
-- Handles two cases:
--   1. Fresh install: create table with canonical schema.
--   2. Pre-existing table (dev had one with only (filename, applied_at)
--      columns from prior ad-hoc tooling): add missing columns and
--      backfill version from filename, rename filename -> name.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  version text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text
);

-- Upgrade path for pre-existing table with filename column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'schema_migrations' AND column_name = 'filename'
  ) THEN
    -- Add columns if missing.
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='name') THEN
      ALTER TABLE schema_migrations ADD COLUMN name text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='version') THEN
      ALTER TABLE schema_migrations ADD COLUMN version text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='checksum') THEN
      ALTER TABLE schema_migrations ADD COLUMN checksum text;
    END IF;

    -- Backfill name from filename and version from the filename's numeric prefix.
    UPDATE schema_migrations
       SET name = COALESCE(name, filename),
           version = COALESCE(version, substring(filename FROM '^(\d+[a-z]?)_'));

    ALTER TABLE schema_migrations ALTER COLUMN name SET NOT NULL;
    ALTER TABLE schema_migrations ALTER COLUMN version SET NOT NULL;
    -- Migrate identity from legacy filename column to name:
    -- 1. add UNIQUE on name, 2. drop legacy filename PK/column.
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'schema_migrations' AND indexname = 'schema_migrations_name_key'
    ) THEN
      ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_name_key UNIQUE (name);
    END IF;
    ALTER TABLE schema_migrations DROP COLUMN filename CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations(applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_schema_migrations_version
  ON schema_migrations(version);
