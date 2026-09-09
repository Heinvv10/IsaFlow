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
-- different journal entry for that period. Reversal rows carry reversal_of
-- and are excluded so a re-post after a reversal stays possible.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Fail closed: refuse to install the constraint while duplicates exist, and
-- name them, so they are corrected deliberately rather than silently kept.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(
           format('company_id=%s loan_id=%s period=%s journals=%s', company_id, loan_id, period, n),
           E'\n')
    INTO dupes
    FROM (
      SELECT company_id, loan_id, period, COUNT(DISTINCT journal_entry_id) AS n
        FROM loan_gl_postings
       WHERE reversal_of IS NULL AND journal_entry_id IS NOT NULL
       GROUP BY company_id, loan_id, period
      HAVING COUNT(DISTINCT journal_entry_id) > 1
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'loan_gl_postings holds duplicate period journals; reverse the extra journals before applying this migration:%s', E'\n' || dupes;
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
