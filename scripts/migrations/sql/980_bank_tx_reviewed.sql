-- 980: Record who reviewed a bank statement line and when (Hein, 2026-11-12: bank transactions stay in Reviewed
-- after a reconciliation; review is an attributable fact, separate from status; a reconciliation cannot complete
-- while a line it covers is unreviewed).
--
--   1. bank_transactions.reviewed_at / reviewed_by. Review ("Review" on the New tab) stamps both. Until now review
--      only flipped status to 'matched', so a reopened reconciliation (which restores allocated lines to
--      'allocated') silently sent reviewed lines back to New, and nothing said who reviewed a line.
--
--   2. Backfill: every line that is 'matched' or 'reconciled' today was shown on the Reviewed tab (or reconciled),
--      so it is recorded reviewed at its last update, reviewer unknown (reviewed_by NULL). Historical reconciled
--      lines that were never reviewed (allocated lines a session reconciled directly) are indistinguishable and are
--      backfilled too; reviewed_by NULL is how the UI shows "reviewer unknown". The UPDATE fires
--      trg_bank_transactions_updated_at, so updated_at moves to the migration time; reviewed_at takes the OLD value.
--
--   3. A line that goes back to 'imported', 'provisional' or 'excluded' is no longer reviewed: the trigger clears
--      both columns whenever status moves to one of those, whoever writes it (unmatch, reversal, exclude, a script).
--      A stale stamp would otherwise put a line straight back on Reviewed the next time it is allocated.
--
-- Expand-only: the old code never names the columns; rolled back, they sit unused and the trigger only clears them.
-- Deploy after hours (the backfill rewrites every matched/reconciled row).

SET LOCAL lock_timeout = '5s';

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID;

UPDATE bank_transactions
SET reviewed_at = COALESCE(updated_at, created_at, NOW())
WHERE status IN ('matched', 'reconciled') AND reviewed_at IS NULL;

CREATE OR REPLACE FUNCTION public.bank_tx_review_reset() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('imported', 'provisional', 'excluded') THEN
    NEW.reviewed_at := NULL;
    NEW.reviewed_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_tx_review_reset ON bank_transactions;
CREATE TRIGGER trg_bank_tx_review_reset
  BEFORE INSERT OR UPDATE OF status ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.bank_tx_review_reset();

CREATE INDEX IF NOT EXISTS idx_bank_tx_account_reviewed
  ON bank_transactions (company_id, bank_account_id, status, reviewed_at);
