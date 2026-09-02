-- 527: credit_notes.applied_amount — what was ACTUALLY credited to the invoice
--
-- The apply and un-apply paths disagreed about how much a note is worth.
--
--   applyCreditNoteToInvoice credits min(total_amount, outstanding) — a PARTIAL
--   application, capped at what the invoice still owes.
--   cancelCreditNote un-credited total_amount, unconditionally.
--
-- Proven against a real database: invoice total 1000 with 950 already paid in
-- CASH (outstanding 50); approve a 115 credit note and apply it, and the apply
-- correctly adds only 50 (amount_paid 1000, status paid). Cancel that note and
-- amount_paid becomes GREATEST(0, 1000 - 115) = 885 — the invoice now shows 115
-- outstanding when the true figure is 50, and R65 of the customer's real cash
-- receipt has been erased from the subledger. GREATEST(0, ...) absorbed the
-- discrepancy silently rather than failing.
--
-- Storing the applied amount is what makes the two paths agree. Reversing a
-- derived figure was the defect; reversing the recorded one cannot drift.
--
-- Backfill: every currently-'applied' note gets applied_amount = total_amount.
-- That is exact for the auto-apply path in approveCreditNote (which adds the
-- full total with no cap) and it is what the cancel path already assumed for
-- the manual path, so no existing row's behaviour changes — while every new
-- application records the truth.

ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS applied_amount NUMERIC(15,2) NOT NULL DEFAULT 0;

UPDATE credit_notes
SET applied_amount = total_amount
WHERE status = 'applied' AND applied_amount = 0;

-- ── Stranded rows from the pre-526 cancellation bug ─────────────────────────
--
-- Every pre-526 cancel threw on the final UPDATE, AFTER reverseJournalEntry and
-- the amount_paid decrement had already committed — so an interrupted attempt
-- leaves a note still marked approved/applied whose journal is already reversed
-- and whose invoice was already un-applied. Such a note claims credit the
-- ledger has taken back. No row reaching status='cancelled' is NOT evidence
-- that no row was left in that half-state; it has to be checked separately.
--
-- Checked before writing this: 0 rows in dev and 0 in production. The statement
-- below is therefore a no-op today and is here so that it stays correct if an
-- attempt lands between this being written and being deployed. It completes the
-- interrupted operation rather than inventing a new state — the reversal and
-- the un-apply already happened, so 'cancelled' is what the row should have
-- reached.
UPDATE credit_notes cn
SET status = 'cancelled',
    cancelled_at = COALESCE(cn.cancelled_at, je.reversed_at),
    cancel_reason = COALESCE(cn.cancel_reason, 'Completed by migration 527: journal already reversed')
FROM gl_journal_entries je
WHERE je.id = cn.gl_journal_entry_id
  AND cn.status IN ('approved', 'applied')
  AND je.reversed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cn_applied_amount
  ON credit_notes(applied_amount) WHERE applied_amount > 0;
