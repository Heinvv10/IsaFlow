-- scripts/migrations/sql/998_bank_import_batch_balance_source.sql
-- Where an import batch's opening/closing balance came from, or why it has none (WP1 PR-A).
--   printed          the file states it (OFX LEDGERBAL BALAMT, MT940 :60F:/:62F:)
--   running_balance  derived from the lines' own running balance, whose chain agrees with every line's amount
--   pdf_read         the same chain read from a PDF's text: taken from the PDF's running-balance column, NOT checked
--                    against a printed closing (no PDF parser reads one), so never 'running_balance'
--   ai_read          a PDF statement's balance as read by the AI model (bank-statements commit): never 'printed'
--   not_in_file      the file format carries no balance (QIF, a CSV without a balance column, a feed, a worksheet)
--   unverified       the file carries one, but it cannot be trusted (a skipped line, a broken or ambiguous chain, an
--                    unreadable balance, two accounts in one file, a line after the statement date, ...): the
--                    figures are NOT written
-- NULL is a batch imported before this column existed. No backfill.
--
-- Additive and idempotent. The app writes the column only at INSERT (nothing UPDATEs a batch, 877), which
-- app_user's table-level INSERT grant (442) already covers. On a first run every existing row is NULL, so the
-- validation scan passes. The runner applies each file in one transaction (scripts/lib/migrationFiles.ts applyOne),
-- which SET LOCAL needs.
--
-- ADD COLUMN without a default rewrites nothing, but takes the table's ACCESS EXCLUSIVE lock for an instant and
-- would queue requests behind a long transaction while it waits: lock_timeout makes it fail fast instead.
SET LOCAL lock_timeout = '5s';

ALTER TABLE bank_import_batches ADD COLUMN IF NOT EXISTS balance_source TEXT;

-- The CHECK is dropped if present and added again, so a run of this file always ends with exactly these six values,
-- however often it is run. It is re-runnable BY HAND: the migration runner itself refuses a database that applied an
-- earlier draft of this file (the checksum no longer matches), and none has (isaflow_dev checked 2026-11-15: no
-- column, constraint or schema_migrations row). Added NOT VALID, then validated. In this one transaction the ADD's
-- ACCESS EXCLUSIVE lock is held to the end anyway (lock_timeout bounds the wait for it); the scan is one pass over
-- bank_import_batches, one row per imported statement.
ALTER TABLE bank_import_batches DROP CONSTRAINT IF EXISTS bank_import_batches_balance_source_ck;
ALTER TABLE bank_import_batches ADD CONSTRAINT bank_import_batches_balance_source_ck
  CHECK (balance_source IS NULL OR balance_source IN ('printed','running_balance','pdf_read','ai_read','not_in_file','unverified')) NOT VALID;
ALTER TABLE bank_import_batches VALIDATE CONSTRAINT bank_import_batches_balance_source_ck;
