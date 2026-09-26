-- 708: R-088 — the content fingerprint a receipt is POSTED under.
--
-- Every upload is a new captured_documents row, so the per-document fence
-- (`posted_at`, migration 672) never sees a second upload of the same slip:
-- re-uploading it, or the same slip arriving by email and WhatsApp, booked the
-- expense and the bank credit again. The receipt posting paths
-- (receipt-to-journal, capture/[id]/post-expense) now check for an earlier
-- posted document with the same bytes (`raw_bytes_sha256`, written at intake)
-- or the same normalised vendor|date|total|VAT key before they post, and stamp
-- what they posted under into these columns in the same UPDATE that claims
-- the document (`claimCapturedDocumentForPosting`).
--
--   posted_content_sha256  the document's raw_bytes_sha256 at posting time
--   posted_receipt_key     `receiptContentKey(extracted)`, NULL when the
--                          extraction lacks a vendor, a date or a total
--   posted_duplicate_of    the earlier document a PERSON confirmed this one
--                          repeats (`confirmDuplicate: true`); NULL otherwise
--
-- The partial UNIQUE index is the backstop behind the application check, as
-- uq_gl_je_capture_source_document is behind the claim: two concurrent posts
-- of the same BYTES cannot both land, and neither can a posting path that
-- forgets to check. A confirmed repeat carries `posted_duplicate_of` and is
-- outside the index, so the override the routes offer is not refused here.
-- The receipt key is NOT unique: two genuine receipts can share vendor, date,
-- total and VAT and differ only in their printed reference number, which the
-- route's check reads to tell them apart (a rule an index cannot express).
-- The check serialises on the key with an advisory lock instead.
--
-- Releasing the claim (reversal, draft discard, claim rejection) clears all
-- three columns, so an undone posting frees its fingerprint.
--
-- The columns are new and NULL on every existing row, so the index cannot
-- fail to build on production duplicates already in the table, and nothing is
-- backfilled: rows posted before this migration are matched by the routes on
-- raw_bytes_sha256 (the byte check reads that column directly), but not on the
-- receipt key, which they never recorded.
ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS posted_content_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS posted_receipt_key TEXT,
  ADD COLUMN IF NOT EXISTS posted_duplicate_of UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_captured_documents_posted_content
  ON captured_documents(company_id, posted_content_sha256)
  WHERE posted_content_sha256 IS NOT NULL AND posted_duplicate_of IS NULL;

-- The route's check reads posted receipts by key; the byte check uses
-- idx_captured_documents_sha_company (436).
CREATE INDEX IF NOT EXISTS idx_captured_documents_posted_receipt_key
  ON captured_documents(company_id, posted_receipt_key)
  WHERE posted_receipt_key IS NOT NULL;
