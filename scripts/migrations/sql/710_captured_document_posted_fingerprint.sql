-- 710: R-088 — the content a captured document is POSTED under.
--
-- Every upload is a new captured_documents row, so the per-document fence
-- (`posted_at`, migration 672) never sees a second upload of the same slip:
-- re-uploading it, or the same slip arriving by email and WhatsApp, booked the
-- expense and the bank credit again — or booked it once as a receipt journal
-- and again as a supplier invoice. `claimCapturedDocumentForPosting` and
-- `claimLineSourceDocuments` now refuse a FILE already booked from another
-- upload in the company, and stamp what they book in the same UPDATE as the
-- claim:
--
--   posted_content_sha256          the row's own raw_bytes_sha256, stamped by
--                                  every claimer except the provisional
--                                  evidence attach, which books nothing new
--                                  (it hangs the slip on a journal that already
--                                  expensed the bank line — see
--                                  postedContentFence.ts and R-127)
--   posted_receipt_key             receipt paths only: `receiptContentKey`,
--                                  NULL when the extraction lacks a vendor, a
--                                  date or a total
--   posted_duplicate_of            the earlier document a PERSON confirmed this
--                                  one repeats (`confirmDuplicate: true`) —
--                                  allowed for a same-details match only, never
--                                  for the same file
--   posted_duplicate_confirmed_by  who confirmed it (users.id is TEXT-shaped,
--                                  as in 704/705/707)
--
-- The partial UNIQUE index is the backstop behind the application checks, as
-- uq_gl_je_capture_source_document is behind the claim: two live postings of
-- the same bytes cannot both land, whichever path writes them. It has NO
-- exemption for a confirmed repeat: a repeat can only be confirmed when its
-- bytes differ, so every stamped posting is inside it. `posted_at IS NOT NULL`
-- keeps a released posting out of it even if a release path ever forgets the
-- stamp (releaseCapturedDocumentPostingClaim clears all four columns).
-- The receipt key is NOT unique: two genuine receipts can share vendor, date,
-- total and VAT and differ only in their printed reference number, which the
-- routes' check reads to tell them apart (a rule an index cannot express).
-- That check serialises on the key with an advisory lock instead.
--
-- The columns are new and NULL on every existing row, so the index cannot
-- fail to build on production duplicates already in the table, and nothing is
-- backfilled. Rows posted before this migration are still matched on
-- raw_bytes_sha256 (the check reads that column directly), but not on the
-- receipt key, which they never recorded: scripts/r088-posted-receipt-key-census.ts
-- reports them and writes the backfill SQL for a person to review and run.
ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS posted_content_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS posted_receipt_key TEXT,
  ADD COLUMN IF NOT EXISTS posted_duplicate_of UUID,
  ADD COLUMN IF NOT EXISTS posted_duplicate_confirmed_by TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_captured_documents_posted_content
  ON captured_documents(company_id, posted_content_sha256)
  WHERE posted_content_sha256 IS NOT NULL AND posted_at IS NOT NULL;

-- The route's check reads posted receipts by key; the byte check uses
-- idx_captured_documents_sha_company (436).
CREATE INDEX IF NOT EXISTS idx_captured_documents_posted_receipt_key
  ON captured_documents(company_id, posted_receipt_key)
  WHERE posted_receipt_key IS NOT NULL;
