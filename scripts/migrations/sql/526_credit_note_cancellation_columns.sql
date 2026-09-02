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
-- Adding the columns is what makes the existing service correct; no data
-- backfill is possible or needed, because no row ever cancelled.

ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS cancelled_by UUID;
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- Mirrors idx_cn_status usage: the cancellation review screens filter on
-- status and then order by when it happened.
CREATE INDEX IF NOT EXISTS idx_cn_cancelled_at
  ON credit_notes(cancelled_at) WHERE cancelled_at IS NOT NULL;
