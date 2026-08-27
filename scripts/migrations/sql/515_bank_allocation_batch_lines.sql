-- Migration 515: record WHICH journal each bulk-allocated line posted.
--
-- Follow-up to mig 514, from the adversarial review of PR #263.
--
-- `bank_transactions.allocation_batch_id` alone says a row was part of a batch.
-- It does NOT say the journal currently hanging off that row is the one the
-- batch posted. Reverse the row on its own, re-allocate it somewhere else, and
-- a later reverse_bank_allocation_batch would reverse the NEW journal — a
-- correct-looking call silently unwinding a posting the batch never made.
--
-- The clearing of allocation_batch_id in allocateTransaction /
-- reverseReconciledTransaction (same change) closes the ordinary route into
-- that state. This table is the check that does not depend on every present and
-- future write path remembering to clear a column: the reverse tool compares
-- the recorded journal_entry_id against the row's CURRENT journal and skips any
-- line that has moved on, rather than reversing something it did not post.
--
-- Append-only, like the batch header: a reversal clears the transaction stamp
-- and leaves these rows as the record of what the batch did.

CREATE TABLE IF NOT EXISTS bank_allocation_batch_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  batch_id uuid NOT NULL REFERENCES bank_allocation_batches(id),
  bank_transaction_id uuid NOT NULL,
  journal_entry_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per transaction per batch. A batch that tried to record the same
-- transaction twice is the duplicate the tool already refuses pre-write; this
-- is the database saying so too.
CREATE UNIQUE INDEX IF NOT EXISTS bank_allocation_batch_lines_uq
  ON bank_allocation_batch_lines (batch_id, bank_transaction_id);

CREATE INDEX IF NOT EXISTS bank_allocation_batch_lines_company_batch_idx
  ON bank_allocation_batch_lines (company_id, batch_id);

-- Tenant isolation — mirror of mig 507/514 (helpers from mig 348).
ALTER TABLE bank_allocation_batch_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_allocation_batch_lines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_allocation_batch_lines;
CREATE POLICY tenant_isolation ON bank_allocation_batch_lines
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT ON bank_allocation_batch_lines TO app_user;
