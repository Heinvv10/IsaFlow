-- 884: VALIDATE the six CC1 / CC2 / BU foreign keys added NOT VALID in 878
-- (bank_transactions) and 882 (gl_journal_lines).
--
-- 878 and 882 added them NOT VALID so an orphan already in the data could not
-- fail that deploy. A read-only census on production (2026-10-10, Hein's OK)
-- found 0 orphans in all six columns (gl_journal_lines cc1 25,379 / cc2 19,896
-- / bu 16,025 tagged rows; bank_transactions 0 tagged), so they can be
-- validated: from here on the database, not just new writes, guarantees every
-- stored dimension id names a real master row.
--
-- LOCKS. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the referencing
-- table and ROW SHARE on the master. SHARE UPDATE EXCLUSIVE does not conflict
-- with ROW EXCLUSIVE, so inserts, updates and deletes on gl_journal_lines and
-- bank_transactions keep running while the existing rows are scanned, and no
-- allocation or posting can deadlock with it. It is held to COMMIT
-- (apply-migrations.ts runs each file in one transaction); it only blocks other
-- DDL, VACUUM and CREATE INDEX on those tables meanwhile.
--
-- Each constraint is validated only if it exists and is not yet validated, so a
-- rerun is a no-op and a database without 878/882 applied is left alone.
-- If an orphan has appeared since the census, VALIDATE fails with 23503 naming
-- the row; the whole file rolls back and nothing changes. Re-run the per-column
-- census from 878/882 to find it.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND NOT c.convalidated
       AND c.conname IN (
         'bank_transactions_cc1_id_fkey', 'bank_transactions_cc2_id_fkey', 'bank_transactions_bu_id_fkey',
         'gl_journal_lines_cc1_id_fkey', 'gl_journal_lines_cc2_id_fkey', 'gl_journal_lines_bu_id_fkey')
     ORDER BY c.conname
  LOOP
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;
