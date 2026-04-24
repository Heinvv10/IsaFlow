-- 446_bank_import_batches_bulk.sql
-- Adds bulk-import bookkeeping to bank_import_batches and fixes a latent
-- FK problem so the table actually becomes writable by the new bulk
-- import endpoints.
--
-- Background:
--   - Migration 442 restored bank_import_batches but no service writes
--     to it today (the comment in 442 explicitly notes "no live writer").
--   - Its bank_account_id column has FK REFERENCES bank_accounts(id),
--     but every other part of the bank-import pipeline keys off
--     gl_accounts.id (where account_subtype='bank'). The two ID spaces
--     are not aligned, so any INSERT using a gl_accounts.id would fail
--     the FK. Drop the FK; bank_account_id stays as a bare UUID, used
--     as a join key.
--   - The new bulk-import flow (pages/api/.../bank-transactions-bulk-commit)
--     writes one row per file and groups them under a shared
--     bulk_import_id so the UI can show "Bulk import of 12 files".
--
-- Safe to re-run: all changes use IF [NOT] EXISTS guards.

-- 1. Drop the broken FK so writes succeed.
DO $$ BEGIN
  ALTER TABLE bank_import_batches
    DROP CONSTRAINT IF EXISTS bank_import_batches_bank_account_id_fkey;
EXCEPTION
  WHEN undefined_table THEN NULL;
END $$;

-- 2. Add bulk-grouping columns.
ALTER TABLE bank_import_batches
  ADD COLUMN IF NOT EXISTS bulk_import_id          UUID NULL,
  ADD COLUMN IF NOT EXISTS bulk_sequence           INT  NULL,
  ADD COLUMN IF NOT EXISTS source_file_size_bytes  INT  NULL;

-- 3. Partial index for the future "Bulk imports" listing page.
CREATE INDEX IF NOT EXISTS idx_bank_import_batches_bulk_id
  ON bank_import_batches (bulk_import_id)
  WHERE bulk_import_id IS NOT NULL;
