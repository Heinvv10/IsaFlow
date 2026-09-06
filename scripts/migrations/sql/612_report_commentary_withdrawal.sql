-- scripts/migrations/sql/612_report_commentary_withdrawal.sql
-- WS3: who withdrew an approval, and when.
--
-- Regenerating with `replace: true` moves an approved row back to 'draft'.
-- Before this migration it also nulled approved_text, approved_by and
-- approved_at in the same statement, so the record of who put their name to
-- that sentence was destroyed by the act of withdrawing it — and nothing at all
-- recorded who did the withdrawing. A client asking "who signed off on the
-- March commentary, and who took it back?" had no answer in the database.
--
-- The fix is two columns and one change in the service: the approval columns
-- are LEFT ALONE and the withdrawal is stamped instead. Nothing leaks by
-- keeping approved_text: `sharedPackService.loadApprovedCommentary` filters on
-- status = 'approved', and a withdrawn row is 'draft'. The 611 CHECK
-- (report_commentary_approved_chk) constrains only the 'approved' direction —
-- an approved row must carry text, approver and timestamp — so a draft row
-- carrying all three is legal under it and needs no constraint change.
--
-- Nullable, no default, no DML: every existing row is a row whose approval was
-- never withdrawn under a schema that could record it, and inventing a
-- withdrawer for it would be a fabrication in an audit column.

ALTER TABLE report_commentary
  ADD COLUMN IF NOT EXISTS withdrawn_by TEXT,
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;

COMMENT ON COLUMN report_commentary.withdrawn_by IS
  'User who last withdrew an approval by regenerating with replace=true. approved_by is preserved alongside it.';
COMMENT ON COLUMN report_commentary.withdrawn_at IS
  'When that withdrawal happened. NULL means no approval on this row has ever been withdrawn.';
