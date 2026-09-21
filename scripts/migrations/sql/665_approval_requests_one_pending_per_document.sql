-- 665 — one pending approval request per document.
--
-- approvalService's "one pending request per document" was a comment, not an
-- invariant: the SELECT-then-INSERT in requestApproval has a window, and two
-- concurrent POSTs both returned 200 and left two pending rows bound to
-- DIFFERENT rules. Two pending rows is itself a way to choose the governing
-- rule — the laxer one is decidable on its own while the stricter sits pending —
-- and getPendingCount/listRequests double-count the document.
--
-- Duplicates are collapsed BEFORE the index is built, keeping the row whose rule
-- demands the highest rank (the ladder in approvalAuthority.ts), ties broken by
-- the earliest request. The losers are cancelled, not deleted: they are audit
-- rows, and cancelling says what happened to them.

WITH ranked AS (
  SELECT ar.id,
         ROW_NUMBER() OVER (
           PARTITION BY ar.company_id, ar.document_type, ar.document_id
           ORDER BY CASE COALESCE(rl.approver_role, 'admin')
                      WHEN 'super_admin' THEN 8
                      WHEN 'owner'       THEN 7
                      WHEN 'system'      THEN 6
                      WHEN 'admin'       THEN 5
                      WHEN 'manager'     THEN 4
                      WHEN 'accountant'  THEN 3
                      WHEN 'bookkeeper'  THEN 2
                      WHEN 'storeman'    THEN 1
                      WHEN 'technician'  THEN 1
                      WHEN 'user'        THEN 1
                      WHEN 'viewer'      THEN 0
                      ELSE 5
                    END DESC,
                    ar.requested_at ASC NULLS LAST,
                    ar.id ASC
         ) AS rn
  FROM approval_requests ar
  LEFT JOIN approval_rules rl ON rl.id = ar.rule_id AND rl.company_id = ar.company_id
  WHERE ar.status = 'pending' AND ar.company_id IS NOT NULL
)
UPDATE approval_requests ar
SET status = 'cancelled',
    decision_notes = COALESCE(ar.decision_notes || ' | ', '')
      || 'Cancelled by migration 665: a second pending request existed for this document.'
FROM ranked
WHERE ranked.id = ar.id AND ranked.rn > 1;

-- Partial unique index: only pending rows are constrained, so a document may be
-- re-requested after its earlier request was approved, rejected or cancelled.
-- Rows with a NULL company_id (migration 234's unscoped seeds) are not covered —
-- NULLs are distinct — and requestApproval always writes the column.
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_requests_pending
  ON approval_requests (company_id, document_type, document_id)
  WHERE status = 'pending';
