-- Migration 706: link a captured document to a POSTED journal entry
--
-- VAT-gaps batch item 1. Manual, recurring, Sage-GL-import and migration
-- journals that claim input VAT have no way to attach evidence after the
-- fact — `gl_journal_entries.source_document_id` is only ever set at
-- creation or by the two evidence-attach paths (provisionalEvidenceAttach.ts,
-- evidenceAttachmentService.ts), and both of those are scoped to a
-- BANK-FIRST PROVISIONAL journal specifically: `source_document_id` there
-- means "this journal was created FROM this capture", which is not true of
-- a plain manual/recurring/import journal linked after posting. Re-using the
-- column for that case would corrupt what it already means to
-- `documentJournalClaimGuard.ts` and the capture posting fence
-- (`captured_documents.posted_at`). This is a separate link table instead.
--
-- One document, one claim still holds: a partial unique index allows at most
-- one ACTIVE (unlinked_at IS NULL) link per (company_id, captured_document_id).
-- Unlinking is allowed and kept as history, same shape as vat_period_locks'
-- unlock and vat_declared_elsewhere's unmark.
CREATE TABLE IF NOT EXISTS gl_journal_document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  journal_entry_id UUID NOT NULL REFERENCES gl_journal_entries(id),
  captured_document_id UUID NOT NULL REFERENCES captured_documents(id),
  linked_by UUID NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  unlinked_at TIMESTAMPTZ,
  unlinked_by UUID,
  unlink_reason TEXT,
  CONSTRAINT gl_journal_document_links_unlink_all_or_none CHECK (
    (unlinked_at IS NULL AND unlinked_by IS NULL AND unlink_reason IS NULL)
    OR (unlinked_at IS NOT NULL AND unlinked_by IS NOT NULL AND unlink_reason IS NOT NULL)
  )
);

-- One document, one claim: at most one ACTIVE link per document per company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_journal_document_links_active_document
  ON gl_journal_document_links (company_id, captured_document_id)
  WHERE unlinked_at IS NULL;

-- The journal-detail page and the classifier both look up by journal.
CREATE INDEX IF NOT EXISTS idx_gl_journal_document_links_journal
  ON gl_journal_document_links (company_id, journal_entry_id)
  WHERE unlinked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gl_journal_document_links_document
  ON gl_journal_document_links (company_id, captured_document_id);
