-- 956: customer_invoice_items.line_position, the order a line was entered in
-- (master plan wave 3, PR S #1084; Hein chose this over re-ordering the
-- approval digest, 2026-11-04).
--
-- An invoice's lines print in the order the user entered them. Create and the
-- draft PUT write each line's 0-based index in the submitted array here; the
-- detail GET and the PDF model order by line_position NULLS LAST, created_at,
-- id. Lines written in one transaction share created_at (NOW()), so created_at
-- cannot carry that order: and it must not, because approval_document_digest
-- (migration 874, as redefined by 923) orders a customer invoice's lines by
-- created_at first and then by content. Equal created_at keeps the approval
-- digest independent of entry order: reordering lines changes what the PDF
-- prints (the invoice's shown digest covers that), not what posts. This column
-- is deliberately NOT in approval_document_digest, which is untouched here.
--
-- Nullable, no default and no backfill: every other writer (recurring runs,
-- quote and sales-order conversion, WIP and time-entry billing, Sage import)
-- leaves it NULL, and those lines keep the order they had (created_at, id),
-- after any positioned line. Catalogue-only (no row rewrite); no trigger or
-- policy on the table; the table-level grants (app_user, platform_admin,
-- migration_admin) cover the new column. Safe to re-run. Waits at most 5s for
-- the table's lock, as 953 does, so a busy table fails the deploy instead of
-- queueing every request behind it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE customer_invoice_items
  ADD COLUMN IF NOT EXISTS line_position INTEGER NULL;

COMMENT ON COLUMN customer_invoice_items.line_position IS
  'The line''s 0-based position on the invoice as entered (create and the draft PUT). Readers order by line_position NULLS LAST, created_at, id. NULL: written by another path or before migration 956. Not approval content (approval_document_digest does not read it).';
