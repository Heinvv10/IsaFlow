-- A failed or interrupted capture read can be retried, because the upload is now stored.
--
--   read_attempt  counts the reads started for a row: 0 for the first, +1 on every retry. A job writes
--                 only while the row still carries the attempt it was started for, so a read thought dead
--                 (stale) that finishes or fails late cannot touch the row its retry is reading
--                 (the same fence as bank_statement_imports.extraction_attempt).
--                 DEFAULT 0: every existing row, and every other inserter, has had no retry.
--
-- lock_timeout is set before the ALTER so the ACCESS EXCLUSIVE wait (the column is catalogue-fast: the
-- default is constant) fails in 5 s instead of queueing every capture query.
--
-- Rollback (no 'reading' job may be in flight):
--   ALTER TABLE captured_documents DROP COLUMN IF EXISTS read_attempt;

SET LOCAL lock_timeout = '5s';

ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS read_attempt INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN captured_documents.read_attempt IS
  'Reads started for this row: 0 for the first, +1 per retry. A reading job writes only while it holds the current attempt.';
