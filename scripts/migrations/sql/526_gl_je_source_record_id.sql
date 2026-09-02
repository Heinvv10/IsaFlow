-- Migration 526: gl_journal_entries.source_record_id
--
-- Migration 409 repointed source_document_id at captured_documents and added
-- fk_gl_je_source_document, which is right for OCR provenance and wrong for
-- everything else: two services still wrote the id of the record that CAUSED
-- the journal into that column and now fail the FK on insert —
--   * createAdjustmentEntry (bank reconciliation adjustments) wrote the
--     reconciliation id,
--   * applyDRCVat wrote the supplier invoice id.
-- Both are dead code paths today; 409 also NULLed the links the old rows had,
-- so no journal can be traced back to the record behind it any more.
--
-- source_record_id is that link, kept separate from the document one. It is
-- POLYMORPHIC and deliberately carries no FK: which table it points at is
-- decided by `source` (auto_bank_recon -> bank_reconciliations,
-- auto_vat_adjustment -> supplier_invoices, ...). A single FK cannot express
-- that, and the alternative — one nullable typed column per source — grows a
-- column per feature.
--
-- Old rows cannot be backfilled: 409 discarded the values.

ALTER TABLE gl_journal_entries
  ADD COLUMN IF NOT EXISTS source_record_id UUID;

COMMENT ON COLUMN gl_journal_entries.source_record_id IS
  'Id of the record that caused this journal, keyed by `source` (no FK: the target table varies). Distinct from source_document_id, which is a captured_documents FK.';

CREATE INDEX IF NOT EXISTS idx_gl_je_source_record
  ON gl_journal_entries(source_record_id)
  WHERE source_record_id IS NOT NULL;
