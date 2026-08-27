-- Migration 514: bank allocation batches (PRD-11 §4)
--
-- `bulk_allocate_bank_transactions` posts up to 500 journals in one MCP call.
-- Without a batch identity the only way to undo that set is 500 separate
-- reversals, each of which can fail halfway and leave the ledger in a state
-- nobody chose. This table gives the set one id; `reverse_bank_allocation_batch`
-- reverses everything stamped with it.
--
-- The stamp is on bank_transactions, NOT on gl_journal_entries. Reversal starts
-- from the transaction (the journal is reached through matched_journal_line_id)
-- and must CLEAR the stamp so the row can be re-allocated into a later batch —
-- a journal-side column could not be cleared without rewriting a posted entry.
--
-- created_by is text, matching mcp_tool_calls.user_id: the MCP context carries
-- the GoTrue subject as a string and there is no users FK to hang it on.
--
-- Batch rows are append-only from the app (no UPDATE/DELETE grant): a reversal
-- clears the transaction stamps and leaves the batch row as the audit record of
-- what was posted.

CREATE TABLE IF NOT EXISTS bank_allocation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  tool text NOT NULL,
  line_count integer NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  idempotency_key text
);

CREATE INDEX IF NOT EXISTS bank_allocation_batches_company_created_idx
  ON bank_allocation_batches (company_id, created_at DESC);

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS allocation_batch_id uuid;

-- Company first: every read of this column is already fenced to the tenant, and
-- the reverse tool's lookup is exactly (company_id, allocation_batch_id).
CREATE INDEX IF NOT EXISTS bank_transactions_allocation_batch_idx
  ON bank_transactions (company_id, allocation_batch_id);

-- Tenant isolation — mirror of mig 507 (helpers from mig 348).
ALTER TABLE bank_allocation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_allocation_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_allocation_batches;
CREATE POLICY tenant_isolation ON bank_allocation_batches
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT ON bank_allocation_batches TO app_user;
