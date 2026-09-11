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

-- Backfill: a document that ALREADY produced a LIVE journal, supplier invoice
-- or expense claim is posted, and must stay refused. Attachment-only documents
-- (status 'matched' from match_bank_tx, no ledger row) are deliberately left
-- NULL — those are the ones the old fence wrongly blocked. So are documents
-- whose only journal was reversed, whose only invoice was cancelled or whose
-- only claim was rejected.
--
-- The three predicates here are exactly the three NOT EXISTS clauses in
-- `releaseCapturedDocumentPostingClaim` — and they have to be, because a
-- backfill that claims what the release cannot hand back is a fence
-- disagreeing with its own undo. A fourth disjunct, `cd.matched_invoice_id IS
-- NOT NULL`, was in neither the release nor `refusalForPosting`, and nothing
-- anywhere clears that column: every row it claimed was refused by all four
-- posting routes and by confirm and reject, permanently. It is gone. Documents
-- carrying `matched_invoice_id` from `ai-invoice-pipeline`'s duplicate branch
-- produced NO invoice of their own and are correctly left postable.
--
-- The `source`/`reversed_at` scoping also keeps the evidence-attach and
-- bank-allocation journals — which stamp `source_document_id` without posting
-- anything — from claiming a document.
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
     OR EXISTS (SELECT 1 FROM expense_claim_lines ecl
                  JOIN expense_claims ec ON ec.id = ecl.claim_id AND ec.company_id = ecl.company_id
                 WHERE ecl.source_document_id = cd.id AND ecl.company_id = cd.company_id
                   AND ec.status NOT IN ('rejected', 'cancelled'))
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
-- An operator who hits this must clear the duplicates first. Drafts COUNT here, and a draft
-- cannot be reversed (`reverseJournalEntry`: "Can only reverse posted entries"), so the
-- remedy depends on each journal's status. The full procedure is in
-- docs/audits/remediation/K-072/fix.md ("What an operator must do when 672 aborts"); in short:
--
--   1. List every journal in each duplicate group, with its status:
--        SELECT je.company_id, je.source_document_id, je.id, je.entry_number, je.status, je.entry_date
--          FROM gl_journal_entries je
--         WHERE je.source = 'auto_expense_receipt' AND je.source_document_id IS NOT NULL AND je.reversed_at IS NULL
--           AND (je.company_id, je.source_document_id) IN (
--                 SELECT company_id, source_document_id FROM gl_journal_entries
--                  WHERE source = 'auto_expense_receipt' AND source_document_id IS NOT NULL AND reversed_at IS NULL
--                  GROUP BY company_id, source_document_id HAVING COUNT(*) > 1)
--         ORDER BY je.company_id, je.source_document_id, (je.status = 'posted') DESC, je.entry_date, je.created_at;
--   2. Keep one per group: the POSTED journal (the earliest if several), else the earliest.
--   3. A POSTED surplus: REVERSE it (Accounting > General Ledger > the entry > Reverse) — its VAT
--      may already be in a VAT201 and must be corrected in the period that carries it.
--   4. A DRAFT surplus: DELETE it by id, draft-guarded, lines first:
--        DELETE FROM gl_journal_lines WHERE journal_entry_id = '<id>'
--          AND EXISTS (SELECT 1 FROM gl_journal_entries WHERE id = '<id>' AND status = 'draft');
--        DELETE FROM gl_journal_entries WHERE id = '<id>' AND status = 'draft';   -- must report DELETE 1
--   5. Re-run step 1 (no rows), then re-run the deploy.
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
    RAISE EXCEPTION 'K-072: % captured document(s) carry more than one LIVE posting journal, so uq_gl_je_capture_source_document cannot be created. List each group with its status (query in this migration); keep the posted journal, else the earliest; REVERSE a posted surplus in the app; DELETE a draft surplus by id with the draft-guarded SQL; then re-run. See docs/audits/remediation/K-072/fix.md ("What an operator must do when 672 aborts").', dup_count;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_je_capture_source_document
    ON gl_journal_entries(company_id, source_document_id)
    WHERE source_document_id IS NOT NULL
      AND source = 'auto_expense_receipt'
      AND reversed_at IS NULL;
END $$;
