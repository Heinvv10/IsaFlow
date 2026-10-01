-- Migration 622: make a payroll loan reversal exact and traceable (K-022 follow-up)
--
-- Three nullable additions, no backfill. Rows written before this migration
-- keep NULL and the reversal falls back to its previous, approximate path.
--
-- schedule_row_id: applyLoanToRun flags exactly ONE payroll_loan_schedule row,
--   picked by ORDER BY sequence LIMIT 1 over a non-unique index. The reversal
--   had to clear paid_flag by (loan_id, due_period_year, due_period_month),
--   which is a superset. Recording the row it flagged makes the undo exact.
--
-- loan_balance_before: applyLoanToRun clamps the new balance at zero
--   (GREATEST/Math.max), so on a final instalment larger than the balance it
--   subtracted LESS than the schedule principal. The reversal added the full
--   principal back, overshooting. Recording the balance it started from lets
--   the reversal restore that exact figure.
--
-- payroll_loan_payment_reversals.stranded: a payment whose run was deleted has
--   run_id set NULL by its FK, and the FIRST calculation of a replacement run
--   reclaims it. That is a repair of someone else's row, not an undo of the
--   run's own work, and the journal guard cannot cover it — the original run
--   is gone, so there is no journal_entry_id left to check. Flag it so the two
--   are distinguishable in the audit trail.

ALTER TABLE payroll_loan_payments
  ADD COLUMN IF NOT EXISTS schedule_row_id UUID REFERENCES payroll_loan_schedule(id) ON DELETE SET NULL;

ALTER TABLE payroll_loan_payments
  ADD COLUMN IF NOT EXISTS loan_balance_before NUMERIC(14,2);

ALTER TABLE payroll_loan_payment_reversals
  ADD COLUMN IF NOT EXISTS stranded BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN payroll_loan_payments.schedule_row_id IS
  'The payroll_loan_schedule row this payment flagged paid. NULL on rows written before migration 622.';
COMMENT ON COLUMN payroll_loan_payments.loan_balance_before IS
  'payroll_loans.outstanding_balance immediately before this payment was applied, so a reversal restores it exactly. NULL on rows written before migration 622.';
COMMENT ON COLUMN payroll_loan_payment_reversals.stranded IS
  'true when the reversed payment had run_id NULL — its own run was deleted and this run reclaimed the period, rather than undoing its own earlier work.';
