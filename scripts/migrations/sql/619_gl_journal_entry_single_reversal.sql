-- 619: one posted contra per reversed journal entry (K-010)
--
-- reverseJournalEntry claimed the reversal only AFTER posting the contra, so two
-- overlapping callers both posted one and the reversed accounts ended at the
-- negative of the original. The service now claims `reversed_at` atomically
-- before creating anything; this index is the backstop that makes a second
-- link-back impossible at the storage layer.
--
-- LOCKING — READ BEFORE DEPLOYING. `CREATE UNIQUE INDEX` without CONCURRENTLY
-- holds a SHARE lock on gl_journal_entries for the whole build, blocking every
-- INSERT/UPDATE/DELETE on the busiest table in the ledger. CONCURRENTLY is not
-- available through this runner: scripts/apply-migrations.ts wraps each file in
-- BEGIN/COMMIT and CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block. Two acceptable paths:
--   (a) apply in an after-hours window and accept the stall (seconds on a table
--       of this size today), or
--   (b) build it out of band first --
--         CREATE UNIQUE INDEX CONCURRENTLY ux_gl_je_reversal_of
--           ON gl_journal_entries (company_id, reversal_of_id)
--           WHERE reversal_of_id IS NOT NULL;
--       then run this file, whose IF NOT EXISTS turns the CREATE into a no-op
--       while the guard below still runs.
--       CHECK THE BUILD SUCCEEDED FIRST. A CONCURRENTLY build that fails or is
--       cancelled leaves an INVALID index of that name behind, and IF NOT EXISTS
--       matches on name regardless of validity — so the migration would skip the
--       CREATE and leave an index enforcing nothing:
--         SELECT c.relname, i.indisvalid FROM pg_index i
--           JOIN pg_class c ON c.oid = i.indexrelid
--          WHERE c.relname = 'ux_gl_je_reversal_of';
--       Drop an invalid leftover before running this file.

-- Fail closed, and say why. K-010 was reachable in production by a double-click,
-- so duplicate contras are the expected case rather than the exotic one. Without
-- this the CREATE INDEX raises a bare "could not create unique index" and takes
-- the whole deploy with it, naming nothing an operator can act on.
DO $$
DECLARE
  dup_pairs  INTEGER;
  dup_rows   INTEGER;
BEGIN
  SELECT count(*), COALESCE(sum(contras), 0)
    INTO dup_pairs, dup_rows
  FROM (
    SELECT count(*) AS contras
    FROM gl_journal_entries
    WHERE reversal_of_id IS NOT NULL
    GROUP BY company_id, reversal_of_id
    HAVING count(*) > 1
  ) d;

  IF dup_pairs > 0 THEN
    RAISE EXCEPTION
      'K-010: % journal entr(ies) already carry more than one contra (% contra rows). '
      'Repair them before this index can be created — see '
      'docs/audits/remediation/K-010/fix.md for the impact query.',
      dup_pairs, dup_rows;
  END IF;
END $$;

-- Scoped by company_id like every other tenant index here. Partial, because
-- reversal_of_id is NULL on every non-contra entry.
CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_je_reversal_of
  ON gl_journal_entries (company_id, reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

-- idx_gl_je_reversal_of is a non-unique partial btree on (reversal_of_id) alone.
-- Every lookup in the product is tenant-scoped and now uses the unique index
-- above, whose leading column is company_id; the old one only costs write
-- amplification on the same table.
DROP INDEX IF EXISTS idx_gl_je_reversal_of;
