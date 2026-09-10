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

-- Backfill: a document that ALREADY produced a LIVE journal or supplier invoice
-- is posted, and must stay refused. Attachment-only documents (status 'matched'
-- from match_bank_tx, no ledger row) are deliberately left NULL — those are the
-- ones the old fence wrongly blocked. So are documents whose only journal was
-- reversed or whose only invoice was cancelled: the predicates here are exactly
-- the two NOT EXISTS clauses in `releaseCapturedDocumentPostingClaim`, because a
-- backfill that claims what the release would immediately hand back is a fence
-- disagreeing with its own undo. The `source`/`reversed_at` scoping also keeps
-- the evidence-attach and bank-allocation journals — which stamp
-- `source_document_id` without posting anything — from claiming a document.
UPDATE captured_documents cd
   SET posted_at = COALESCE(cd.updated_at, cd.created_at, NOW())
 WHERE cd.posted_at IS NULL
   AND (
     EXISTS (SELECT 1 FROM gl_journal_entries je
              WHERE je.source_document_id = cd.id AND je.company_id = cd.company_id
                AND je.source = 'auto_expense_receipt' AND je.reversed_at IS NULL)
     OR EXISTS (SELECT 1 FROM supplier_invoices si
                 WHERE si.source_document_id = cd.id AND si.company_id = cd.company_id
                   AND si.status <> 'cancelled')
     OR cd.matched_invoice_id IS NOT NULL
   );

-- Behind the application fence: one LIVE posting journal per captured document,
-- at the database, for every route that exists or gets invented later.
--
-- Scoped to `source = 'auto_expense_receipt'` on purpose — the one source both
-- capture posting JOURNAL routes write (receipt-to-journal.ts,
-- pettyCashJournalService). `source_document_id` is ALSO stamped onto an
-- existing provisional bank journal by the evidence-attach paths
-- (evidenceAttachmentService, provisional/[jeId]/attach) and copied onto an
-- allocation journal by bankAllocationService, none of which are posting
-- events; an unscoped unique index would 23505 a legitimate attach.
--
-- It reaches TWO of the four posting routes and no further: `capture/[id]/post`
-- and `ai-invoice-pipeline` write `supplier_invoices`, a different table. The
-- application claim on `captured_documents.posted_at` is the fence there, and
-- the fix.md table says so route by route.
--
-- `reversed_at IS NULL` is what makes the fence undoable. A reversed journal is
-- not a live posting, and `releaseCapturedDocumentPostingClaim` hands the
-- document back after a reversal — without this predicate the re-post it
-- permits would 23505 against the row it just reversed, so the release would be
-- a promise the index refused to keep.

-- Duplicates ABORT the migration; they do not warn.
--
-- This block used to RAISE WARNING, skip the index and exit 0, on the reasoning
-- that an existing production duplicate must not abort a deploy. That reasoning
-- assumed someone reads the warning. `apply-migrations.ts` registers NO `notice`
-- listener on this branch or on master (the one that surfaces them is R-041, on
-- an unmerged branch), so `RAISE WARNING` goes to a client callback nothing is
-- listening on: the deploy prints nothing, exits 0, and the database ships
-- WITHOUT the constraint with no record that it was skipped.
--
-- An operator who hits this must clear the duplicates first. The query below
-- lists them; for each pair, reverse the journal that should not exist
-- (Accounting > General Ledger > the entry > Reverse — which also releases the
-- document's posting claim) and re-run the migration. Reversal, never DELETE:
-- the incorrect input VAT has already been claimed in a VAT201 and has to be
-- corrected in the period that carries it, not erased.
--
--   SELECT company_id, source_document_id, COUNT(*), array_agg(entry_number)
--     FROM gl_journal_entries
--    WHERE source_document_id IS NOT NULL
--      AND source = 'auto_expense_receipt'
--      AND reversed_at IS NULL
--    GROUP BY company_id, source_document_id
--   HAVING COUNT(*) > 1;
DO $$
DECLARE dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT company_id, source_document_id
      FROM gl_journal_entries
     WHERE source_document_id IS NOT NULL
       AND source = 'auto_expense_receipt'
       AND reversed_at IS NULL
     GROUP BY company_id, source_document_id
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'K-072: % captured document(s) carry more than one LIVE posting journal. uq_gl_je_capture_source_document cannot be created until they are resolved — reverse the duplicate journal(s) (see the query in this migration and docs/audits/remediation/K-072/fix.md), then re-run.', dup_count;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_je_capture_source_document
    ON gl_journal_entries(company_id, source_document_id)
    WHERE source_document_id IS NOT NULL
      AND source = 'auto_expense_receipt'
      AND reversed_at IS NULL;
END $$;
