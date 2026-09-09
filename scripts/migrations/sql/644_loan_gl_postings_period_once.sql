-- K-083 (prefix 644; 629 was taken by an unmerged branch): one journal per (company_id, loan_id, period) for loan GL postings.
--
-- postPeriodJournals used to post unconditionally, so a retry after a client
-- timeout, or a second period-close over a range already closed, doubled the
-- interest expense and the loan-liability movement. The service now refuses a
-- repeat; this constraint is the structural backstop for two concurrent posts.
--
-- Note: loan_gl_postings holds ONE ROW PER JOURNAL LINE, so a plain unique
-- index on (company_id, loan_id, period) would reject the normal path. The
-- exclusion constraint below allows any number of rows sharing a period as
-- long as they all belong to the SAME journal entry, and rejects a second,
-- different journal entry for that period. Rows carrying reversal_of are
-- reversals rather than postings and are excluded.
--
-- This does NOT make a re-post after a GL reversal possible: reversing a
-- journal writes to gl_journal_entries / gl_journal_lines only and leaves the
-- original loan_gl_postings rows in place with reversal_of IS NULL, so they
-- keep blocking. Re-posting a period means deleting or re-pointing those rows
-- first. The remediation is written out in docs/audits/remediation/K-083/fix.md.
--
-- OPERATIONAL NOTES (review L3):
--   * CREATE EXTENSION needs a role permitted to create extensions. btree_gist
--     is a trusted extension from PostgreSQL 13, so a database owner suffices;
--     on PG12 or older it needs a superuser.
--   * ADD CONSTRAINT ... EXCLUDE takes an ACCESS EXCLUSIVE lock on
--     loan_gl_postings while it builds a GiST index over the whole table.
--     Writers and readers block for the duration. Run it in a maintenance
--     window on a large table; loan_gl_postings is small on every tenant seen
--     so far (one row per journal line per posted loan period).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Fail closed: refuse to install the constraint while duplicates exist, and
-- name them, so they are corrected deliberately rather than silently kept.
DO $$
DECLARE
  dupes text;
BEGIN
  -- Name the ROWS, not just the journals (review M2): the operator has to
  -- delete or re-point specific loan_gl_postings rows, and reversing the GL
  -- journal does not touch them.
  SELECT string_agg(
           format('company_id=%s loan_id=%s period=%s journals=%s superseded_row_ids=%s',
                  company_id, loan_id, period, n, ids),
           E'\n')
    INTO dupes
    FROM (
      SELECT company_id, loan_id, period,
             COUNT(DISTINCT journal_entry_id) AS n,
             string_agg(id::text, ',' ORDER BY created_at, id)
               FILTER (WHERE journal_entry_id <> keep_journal) AS ids
        FROM (
          SELECT p.*,
                 FIRST_VALUE(p.journal_entry_id) OVER (
                   PARTITION BY p.company_id, p.loan_id, p.period
                   ORDER BY p.created_at, p.id
                 ) AS keep_journal
            FROM loan_gl_postings p
           WHERE p.reversal_of IS NULL AND p.journal_entry_id IS NOT NULL
        ) ranked
       GROUP BY company_id, loan_id, period
      HAVING COUNT(DISTINCT journal_entry_id) > 1
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION E'loan_gl_postings holds more than one journal for a loan period.\nReverse the superseded GL journals AND delete the loan_gl_postings rows listed as superseded_row_ids, then re-run this migration.\nSee docs/audits/remediation/K-083/fix.md.\n%', dupes;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loan_gl_postings_one_journal_per_period'
  ) THEN
    ALTER TABLE loan_gl_postings
      ADD CONSTRAINT loan_gl_postings_one_journal_per_period
      EXCLUDE USING gist (
        company_id WITH =,
        loan_id WITH =,
        period WITH =,
        journal_entry_id WITH <>
      )
      WHERE (reversal_of IS NULL AND journal_entry_id IS NOT NULL);
  END IF;
END $$;
