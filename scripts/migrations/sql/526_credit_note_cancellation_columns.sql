-- 526: credit_notes cancellation columns
--
-- cancelCreditNote has always written cancelled_by / cancelled_at /
-- cancel_reason, but migration 202 never created them and no later migration
-- added them. Every cancellation therefore threw
--   column "cancelled_by" of relation "credit_notes" does not exist
-- which is why no credit note in any environment has ever reached status
-- 'cancelled' (dev and prod both: 0 rows).
--
-- This is worse than a dead feature. The failing UPDATE is the LAST statement
-- in cancelCreditNote: reverseJournalEntry has already posted a reversing entry
-- and the linked invoice's amount_paid has already been decremented by the time
-- it runs. Each of those manages its own transaction, so the throw left the
-- ledger reversed and the invoice un-applied while the note itself stayed
-- 'approved' / 'applied' — the note claims credit that the GL has already taken
-- back, and a second cancel attempt would reverse it again.
--
-- Adding the columns is what makes the existing service correct. No row ever
-- reached status='cancelled' anywhere, so there is nothing to backfill INTO
-- these columns — but note that this does NOT mean no row was affected: an
-- interrupted attempt leaves a note marked approved/applied over an
-- already-reversed journal. Migration 527 completes any such row (0 in dev and
-- 0 in production at the time of writing).

ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS cancelled_by UUID;
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- Leads with company_id: every query in this codebase is tenant-scoped, so an
-- index on cancelled_at alone could not serve the review screens its own
-- comment cited — the planner would still have to filter the whole tenant set.
-- Not CONCURRENTLY: the column is brand new and entirely NULL, so the build is
-- instantaneous and the write lock is not observable.
DROP INDEX IF EXISTS idx_cn_cancelled_at;
CREATE INDEX IF NOT EXISTS idx_cn_company_cancelled_at
  ON credit_notes(company_id, cancelled_at DESC) WHERE cancelled_at IS NOT NULL;
