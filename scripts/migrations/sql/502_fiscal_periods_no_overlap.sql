-- 502: forbid overlapping fiscal periods per company (P2.2)
--
-- Mig 501's trigger and createJournalEntry both resolve "the period covering
-- entry_date" — with overlapping ranges that lookup is ambiguous, and a
-- misclassified entry would pass the coverage invariant while sitting in the
-- wrong period. No overlaps exist today (verified 0 rows in dev AND prod),
-- so the constraint is purely preventive. Half-open ranges are NOT used:
-- periods are stored with inclusive start/end dates.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE fiscal_periods
  DROP CONSTRAINT IF EXISTS fiscal_periods_no_overlap;
ALTER TABLE fiscal_periods
  ADD CONSTRAINT fiscal_periods_no_overlap
  EXCLUDE USING gist (
    company_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );
