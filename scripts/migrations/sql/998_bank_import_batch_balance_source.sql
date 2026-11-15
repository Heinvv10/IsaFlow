-- scripts/migrations/sql/998_bank_import_batch_balance_source.sql
-- Where an import batch's opening/closing balance came from, or why it has none (WP1 PR-A).
--   printed          the file states it (OFX LEDGERBAL BALAMT, MT940 :60F:/:62F:)
--   running_balance  derived from the lines' own running balance, whose chain agrees with every line's amount
--   ai_read          a PDF statement's balance as read by the AI model (bank-statements commit): never 'printed'
--   not_in_file      the file format carries no balance (QIF, a CSV without a balance column, a feed, a worksheet)
--   unverified       the file carries one, but it cannot be trusted (a skipped line, a broken or ambiguous chain, an
--                    unreadable balance, two accounts in one file, a line after the statement date, ...): the
--                    figures are NOT written
-- NULL is a batch imported before this column existed. No backfill.
--
-- Additive and idempotent. The app writes the column only at INSERT (nothing UPDATEs a batch, 877), which
-- app_user's table-level INSERT grant (442) already covers. The CHECK is added NOT VALID and then validated in the
-- same transaction: every existing row is NULL, so the validation scan passes.
--
-- ADD COLUMN without a default rewrites nothing, but takes the table's ACCESS EXCLUSIVE lock for an instant and
-- would queue requests behind a long transaction while it waits: lock_timeout makes it fail fast instead.
SET LOCAL lock_timeout = '5s';

ALTER TABLE bank_import_batches ADD COLUMN IF NOT EXISTS balance_source TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_import_batches_balance_source_ck'
                 AND conrelid = 'bank_import_batches'::regclass) THEN
    ALTER TABLE bank_import_batches ADD CONSTRAINT bank_import_batches_balance_source_ck
      CHECK (balance_source IS NULL OR balance_source IN ('printed','running_balance','ai_read','not_in_file','unverified')) NOT VALID;
    ALTER TABLE bank_import_batches VALIDATE CONSTRAINT bank_import_batches_balance_source_ck;
  END IF;
END $$;
