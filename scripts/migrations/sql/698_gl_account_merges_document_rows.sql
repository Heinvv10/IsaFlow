-- Migration 698: record the document rows a GL account merge repoints.
--
-- A merge now carries the source's document lines onto the target in the same
-- transaction as its journal lines: supplier_invoice_items.gl_account_id,
-- expense_claim_lines.gl_account_id, po_items.gl_account_id and
-- capture_events.resolved_gl_account_id. Before, those rows refused the merge
-- as "configuration", so an account ever coded on a bill could never be merged
-- and nothing could recode posted bill lines.
--
-- Moving them is only recoverable if the record says which rows moved, for the
-- same reason moved_line_ids exists: merging back does not undo a merge. Shape:
--   {"supplier_invoice_items": [uuid, ...], "expense_claim_lines": [...],
--    "po_items": [...], "capture_events": [...]}
--
-- Additive: existing records (merges before this change moved no document
-- rows) take the empty object, and code on master that does not write the
-- column keeps working.

ALTER TABLE gl_account_merges
  ADD COLUMN IF NOT EXISTS moved_document_rows JSONB NOT NULL DEFAULT '{}'::jsonb;
