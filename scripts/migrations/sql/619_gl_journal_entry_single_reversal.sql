-- 619: one posted contra per reversed journal entry (K-010)
--
-- reverseJournalEntry claimed the reversal only AFTER posting the contra, so two
-- overlapping callers both posted one and the reversed accounts ended at the
-- negative of the original. The service now claims `reversed_at` atomically
-- before creating anything; this index is the backstop that makes a second
-- link-back impossible at the storage layer.
--
-- Scoped by company_id like every other tenant index here. Partial, because
-- reversal_of_id is NULL on every non-contra entry.
--
-- Pre-flight (must return zero rows, or index creation fails):
--   SELECT company_id, reversal_of_id, count(*)
--   FROM gl_journal_entries
--   WHERE reversal_of_id IS NOT NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_je_reversal_of
  ON gl_journal_entries (company_id, reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;
