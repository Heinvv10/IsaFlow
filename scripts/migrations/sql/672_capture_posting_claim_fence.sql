-- K-072 — a captured document gets a posting fence that means one thing.
--
-- `captured_documents.status` was doing four jobs: 'reviewed' (confirm button),
-- 'rejected' (reject button), 'matched' (slip attached to a bank transaction as
-- evidence) and 'matched' again (a posting route settled it). Used as the fence
-- that decides whether a receipt may be posted, it leaked in both directions:
-- the confirm button reset it and a second VAT-bearing journal went through,
-- 'rejected' slipped past a `status <> 'matched'` predicate, and a document
-- merely attached to a bank transaction was refused with "already posted to a
-- journal" while zero journals existed.
--
-- `posted_at` is written by a posting path and by nothing else.

ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;

COMMENT ON COLUMN captured_documents.posted_at IS
  'Posting claim: set by a capture posting route before its first ledger write. NULL = postable. Never written by a lifecycle action (confirm / reject / attach-to-bank-tx).';

CREATE INDEX IF NOT EXISTS idx_captured_documents_unposted
  ON captured_documents(company_id, status)
  WHERE posted_at IS NULL;

-- Backfill: a document that ALREADY produced a journal or a supplier invoice is
-- posted, and must stay refused. Attachment-only documents (status 'matched'
-- from match_bank_tx, no ledger row) are deliberately left NULL — those are the
-- ones the old fence wrongly blocked.
UPDATE captured_documents cd
   SET posted_at = COALESCE(cd.updated_at, cd.created_at, NOW())
 WHERE cd.posted_at IS NULL
   AND (
     EXISTS (SELECT 1 FROM gl_journal_entries je
              WHERE je.source_document_id = cd.id AND je.company_id = cd.company_id)
     OR EXISTS (SELECT 1 FROM supplier_invoices si
                 WHERE si.source_document_id = cd.id AND si.company_id = cd.company_id)
     OR cd.matched_invoice_id IS NOT NULL
   );

-- Behind the application fence: one posting journal per captured document, at
-- the database, for every route that exists or gets invented later.
--
-- Scoped to `source = 'auto_expense_receipt'` on purpose — the one source both
-- capture posting journal routes write (receipt-to-journal.ts,
-- pettyCashJournalService). `source_document_id` is ALSO stamped onto an
-- existing provisional bank journal by the evidence-attach paths
-- (evidenceAttachmentService, provisional/[jeId]/attach), which are not posting
-- events; an unscoped unique index would 23505 a legitimate attach.
--
-- Created conditionally: an existing duplicate pair would abort the deploy, and
-- the application claim is the primary fence either way. The read-only query
-- that finds such pairs is in docs/audits/remediation/K-072/fix.md.
DO $$
DECLARE dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT company_id, source_document_id
      FROM gl_journal_entries
     WHERE source_document_id IS NOT NULL
       AND source = 'auto_expense_receipt'
     GROUP BY company_id, source_document_id
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE WARNING 'K-072: % captured document(s) already carry more than one posting journal; uq_gl_je_capture_source_document NOT created. Resolve the duplicates (see docs/audits/remediation/K-072/fix.md) and re-run this migration.', dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_je_capture_source_document
      ON gl_journal_entries(company_id, source_document_id)
      WHERE source_document_id IS NOT NULL
        AND source = 'auto_expense_receipt';
  END IF;
END $$;
