-- 981: A review covers the journal a line was matched to when it was reviewed (Hein, 2026-11-12; follows 980).
--
-- 980's trigger cleared reviewed_at/reviewed_by only when status went back to imported/provisional/excluded. A
-- reviewed 'matched' line re-matched to a DIFFERENT journal line stays 'matched', so it kept its stamp and the
-- completion gate reconciled a pairing nobody reviewed. The stamp now also clears whenever the line's journal link
-- moves: matched_journal_line_id or provisional_je_id changes, on any writer.
--
-- Replaces the function (same name, same pinned search_path) and recreates the trigger with the wider column list.
-- Plain plpgsql, not SECURITY DEFINER (no definer registry row). No data change; old code is unaffected.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.bank_tx_review_reset() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('imported', 'provisional', 'excluded')
     OR (TG_OP = 'UPDATE' AND (NEW.matched_journal_line_id IS DISTINCT FROM OLD.matched_journal_line_id
                               OR NEW.provisional_je_id IS DISTINCT FROM OLD.provisional_je_id)) THEN
    NEW.reviewed_at := NULL;
    NEW.reviewed_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_tx_review_reset ON bank_transactions;
CREATE TRIGGER trg_bank_tx_review_reset
  BEFORE INSERT OR UPDATE OF status, matched_journal_line_id, provisional_je_id ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.bank_tx_review_reset();
