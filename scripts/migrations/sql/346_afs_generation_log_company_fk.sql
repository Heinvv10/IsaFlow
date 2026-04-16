-- 346_afs_generation_log_company_fk.sql
-- Adds the missing FK on afs_generation_log.company_id → companies(id) ON DELETE CASCADE.
--
-- Why this is a separate migration:
-- Migration 336 originally created afs_generation_log with `company_id UUID NOT NULL` (no FK).
-- Commit 40486ff edited the 336 file source to include the FK, but because 336 had already
-- been applied and CREATE TABLE IF NOT EXISTS is a no-op on re-run, the FK was never actually
-- added to the DB. This migration closes that gap.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'afs_generation_log_company_id_fkey'
      AND conrelid = 'afs_generation_log'::regclass
  ) THEN
    ALTER TABLE afs_generation_log
      ADD CONSTRAINT afs_generation_log_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
  END IF;
END $$;
