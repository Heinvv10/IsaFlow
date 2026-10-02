-- 719: R-111 — reopen a completed bank reconciliation.
--
-- Completion was terminal: nothing could undo it, so a wrong VAT code on an
-- allocated bank line inside a completed reconciliation could only be patched by
-- a hand journal on VAT Input — which carries no VAT code and reads as a
-- blocking VAT201 exception. Reopening returns the session to in_progress and
-- its lines to the state completion took them from; these columns are the audit
-- record of who did that, when and why. completed_by / completed_at are cleared
-- on reopen (the session is no longer completed) and written again on the next
-- completion, so the reopen stamp is the only trace that it ever was.
--
-- Nullable, no default: catalog-only. lock_timeout as 660/717/718 — queued behind
-- a long transaction the ACCESS EXCLUSIVE lock would block every bank read.
SET LOCAL lock_timeout = '5s';

ALTER TABLE bank_reconciliations
  ADD COLUMN IF NOT EXISTS reopened_by UUID,
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopen_reason TEXT;
