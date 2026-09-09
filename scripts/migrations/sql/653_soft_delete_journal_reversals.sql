-- scripts/migrations/sql/653_soft_delete_journal_reversals.sql
-- K-053: record the GL reversal that a soft-delete posted, so the undo can put
-- back exactly that reversal and nothing else.
--
-- Round 2 inferred the state from the reversal chain alone: soft-delete
-- reversed a LIVE chain head, and undo reversed a DEAD one. That is wrong
-- whenever the document arrives at the delete with an already-dead head — a
-- user reversing the approval journal from the GL screen
-- (pages/api/accounting/journal-entries-action.ts) leaves the invoice pointing
-- at the reversed original, unlike cancel, which NULLs the link. The delete
-- then correctly did nothing, but the undo saw a dead head and posted a fresh
-- journal re-instating revenue and VAT output the user had deliberately
-- reversed — and reverseJournalEntry dates the correction back to the original
-- entry date, so it silently re-opened a VAT period.
--
-- One row per document with an ACTIVE soft-delete, removed by the undo. So the
-- table is empty except while documents sit deleted, and its absence is the
-- honest answer to "this delete reversed nothing".
--
-- No FK on created_by: users.id is character varying(255), so a uuid-typed FK
-- to it fails at apply time (see mig 610).

CREATE TABLE IF NOT EXISTS soft_delete_journal_reversals (
  company_id                UUID        NOT NULL REFERENCES companies(id),
  entity_type               TEXT        NOT NULL,
  entity_id                 UUID        NOT NULL,
  reversal_journal_entry_id UUID        NOT NULL REFERENCES gl_journal_entries(id),
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, entity_type, entity_id),
  CONSTRAINT soft_delete_journal_reversals_entity_type_chk
    CHECK (entity_type IN ('customer_invoice', 'supplier_invoice'))
);

-- The undo reads by (company_id, entity_type, entity_id), which the primary key
-- already serves. This index is for the other direction: given a reversal
-- entry, is it one a soft-delete posted? That is the question an operator asks
-- of the GL screen, and the question the historical-repair query asks.
CREATE INDEX IF NOT EXISTS idx_sdjr_reversal_entry
  ON soft_delete_journal_reversals (company_id, reversal_journal_entry_id);

-- Tenant isolation. Shape copied verbatim from 610_report_share_links.sql.
ALTER TABLE soft_delete_journal_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_delete_journal_reversals FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'soft_delete_journal_reversals'
      AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE
      'CREATE POLICY tenant_isolation ON public.soft_delete_journal_reversals TO app_user '
      'USING (company_id IN (SELECT auth.user_companies())) '
      'WITH CHECK (company_id = app.current_company_id())';
  END IF;
END $$;

COMMENT ON TABLE soft_delete_journal_reversals IS
  'K-053: the reversal entry a soft-delete posted for a document, so undoDelete '
  'reverses exactly that entry. Removed by the undo; a missing row means the '
  'delete reversed nothing and the undo must post nothing.';
