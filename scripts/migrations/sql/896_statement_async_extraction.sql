-- Bank and supplier statement extraction runs after the upload request has been answered.
--
-- A dense statement page takes the local vLLM ~55 s, so a multi-page PDF cannot be read inside
-- the 60 s request window. The upload now inserts the row as 'extracting' and answers at once;
-- a background job reads the pages and moves the row to 'extracted' (bank) / 'unreconciled'
-- (supplier), or to 'failed' with a user-safe reason.
--
--   extraction_error        user-safe reason for a 'failed' row
--   extraction_error_code   stable machine marker; 'too_many_pages' is the one a retry cannot fix
--   extraction_heartbeat_at touched after every page read; a row 'extracting' with no heartbeat
--                           for 5 minutes is reported as interrupted (computed on read, no cron)
--   extraction_pages_done / extraction_pages_total   progress shown while 'extracting'
--
-- The status CHECK is inline in 417, so its name is <table>_status_check. It is looked up by
-- definition rather than assumed, so a renamed constraint cannot survive and keep refusing the
-- new values. Both ADDs re-create the CHECK under its canonical name, so a re-run is a no-op.

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS tbl, conname
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN ('bank_statement_imports'::regclass, 'supplier_statement_reconciliations'::regclass)
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', c.tbl, c.conname);
  END LOOP;
END $$;

ALTER TABLE bank_statement_imports
  ADD CONSTRAINT bank_statement_imports_status_check
  CHECK (status IN ('extracting', 'extracted', 'reviewing', 'committed', 'rolled_back', 'failed'));

ALTER TABLE supplier_statement_reconciliations
  ADD CONSTRAINT supplier_statement_reconciliations_status_check
  CHECK (status IN ('extracting', 'unreconciled', 'reconciled', 'disputed', 'archived', 'failed'));

ALTER TABLE bank_statement_imports
  ADD COLUMN IF NOT EXISTS extraction_error         TEXT,
  ADD COLUMN IF NOT EXISTS extraction_error_code    TEXT,
  ADD COLUMN IF NOT EXISTS extraction_heartbeat_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_pages_done    INTEGER,
  ADD COLUMN IF NOT EXISTS extraction_pages_total   INTEGER;

ALTER TABLE supplier_statement_reconciliations
  ADD COLUMN IF NOT EXISTS extraction_error         TEXT,
  ADD COLUMN IF NOT EXISTS extraction_error_code    TEXT,
  ADD COLUMN IF NOT EXISTS extraction_heartbeat_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_pages_done    INTEGER,
  ADD COLUMN IF NOT EXISTS extraction_pages_total   INTEGER;
