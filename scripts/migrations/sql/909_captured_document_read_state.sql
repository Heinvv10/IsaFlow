-- A Document Capture upload is read after the request has been answered.
--
-- A long digital PDF takes the local vLLM 70-104 s, and Cloudflare cuts a request at 100 s. The
-- upload now inserts the row as 'reading' and answers at once; a background job reads the file and
-- moves the row to 'done' (the extracted columns filled) or to 'failed' with a user-safe reason.
--
--   read_state         'reading' while a job reads the upload, 'done' once it finished (or was fenced
--                      out: the row was rejected or posted meanwhile), 'failed' when the job threw.
--                      DEFAULT 'done': every existing row and every other inserter (email, WhatsApp,
--                      mirror, /capture/upload) already carries its extraction and is unchanged.
--   read_error         user-safe reason for a 'failed' row
--   read_heartbeat_at  touched by the job while it waits; a row 'reading' with no sign of life for
--                      5 minutes is reported as interrupted (computed on read, no cron)
--
-- Every existing row is 'done', so the CHECK is added without NOT VALID. The DO block makes a re-run
-- a no-op. lock_timeout is set before the first ALTER, so the ACCESS EXCLUSIVE wait (columns and CHECK
-- are catalogue-fast: the default is constant) fails in 5 s instead of queueing every capture query.
--
-- Rollback:
--   ALTER TABLE captured_documents DROP CONSTRAINT IF EXISTS captured_documents_read_state_check;
--   ALTER TABLE captured_documents DROP COLUMN IF EXISTS read_state, DROP COLUMN IF EXISTS read_error,
--     DROP COLUMN IF EXISTS read_heartbeat_at;   (no 'reading' job may be in flight)

SET LOCAL lock_timeout = '5s';

ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS read_state        TEXT NOT NULL DEFAULT 'done',
  ADD COLUMN IF NOT EXISTS read_error        TEXT,
  ADD COLUMN IF NOT EXISTS read_heartbeat_at TIMESTAMPTZ;

COMMENT ON COLUMN captured_documents.read_state IS
  'reading = a background job is extracting this upload; done = finished (or fenced out); failed = the job threw. Default done.';
COMMENT ON COLUMN captured_documents.read_error IS
  'User-safe reason for read_state = failed.';
COMMENT ON COLUMN captured_documents.read_heartbeat_at IS
  'Last sign of life from the reading job; a reading row silent for 5 minutes is shown as interrupted.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'captured_documents'::regclass AND conname = 'captured_documents_read_state_check'
  ) THEN
    ALTER TABLE captured_documents
      ADD CONSTRAINT captured_documents_read_state_check
      CHECK (read_state IN ('reading', 'done', 'failed'));
  END IF;
END $$;
