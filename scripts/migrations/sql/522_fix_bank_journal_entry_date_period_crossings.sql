-- 522 — re-date the bank-derived journals that sit in the WRONG FISCAL PERIOD.
--
-- Before #276 (99a61c90), bankRuleAutoPostLine derived a journal's entry_date
-- from bank_transactions.transaction_date like this:
--
--     tx.transaction_date instanceof Date
--       ? tx.transaction_date.toISOString().split('T')[0]
--       : ...
--
-- pg returns a DATE (OID 1082) as a JS Date at LOCAL midnight. On the UTC+2 box
-- that is 2026-04-19T00:00+02:00, and .toISOString() re-reads it as
-- 2026-04-18T22:00Z — the PREVIOUS day. #276 fixed the reader (setTypeParser in
-- src/lib/pgTypes.ts) but could not un-write the dates already persisted.
--
-- The bank side was never wrong, and that is proved rather than assumed: 4,213
-- ABSA references self-encode their date as 'YYYYMMDD-NNNN', 4,208 agree with
-- the stored transaction_date exactly, and ZERO disagree by ±1. value_date is
-- NULL on every affected row, so it is not an alternative source either.
-- transaction_date is therefore the truth and entry_date moves toward it.
--
-- SCOPE — deliberately narrow. 2,486 journals are one day early, but 2,178 of
-- them stay inside the correct month: their date is cosmetically wrong and has
-- no effect on any period, VAT return or year-end. This migration touches ONLY
-- the 307 journals whose corrected date lands in a DIFFERENT fiscal period —
-- the entire financial impact (207 cross a bi-monthly VAT boundary, 12 cross
-- Brightsphere's February year-end). Leaving the other 2,178 alone keeps the
-- number of mutated posted ledger rows as small as the correction allows.
--
-- SAFETY, all verified against production before writing this file:
--   * every one of the 307 has an existing target fiscal period, and every one
--     of those periods is 'open' — so nothing needs reopening and no row can
--     end up with a NULL fiscal_period_id (a NULL period makes a journal
--     invisible to the TB, VAT201 and AFS — that failure cost R267,109.70 once).
--   * no journal is linked to two bank transactions bearing different dates,
--     so the new entry_date is deterministic.
--   * no vat_returns rows exist for the affected company, so no filed return
--     was derived from the wrong dates.
--   * trg_gl_je_balanced is BEFORE UPDATE OF status. This statement does not
--     touch status or any amount, so the balance check is neither tripped nor
--     bypassed — debits and credits are untouched.
--
-- Re-running is a no-op: once entry_date = transaction_date the WHERE clause
-- matches nothing.

DO $$
DECLARE
  v_before  integer;
  v_updated integer;
BEGIN
  CREATE TEMP TABLE tmp_522_targets ON COMMIT DROP AS
  SELECT DISTINCT
         je.id                 AS journal_entry_id,
         je.company_id         AS company_id,
         je.entry_date         AS old_entry_date,
         bt.transaction_date   AS new_entry_date,
         je.fiscal_period_id   AS old_fiscal_period_id,
         tgt.id                AS new_fiscal_period_id
    FROM bank_transactions bt
    JOIN gl_journal_lines jl
      ON jl.id = bt.matched_journal_line_id
     AND jl.company_id = bt.company_id
    JOIN gl_journal_entries je
      ON je.id = jl.journal_entry_id
     AND je.company_id = bt.company_id
    JOIN fiscal_periods tgt
      ON tgt.company_id = je.company_id
     AND bt.transaction_date BETWEEN tgt.start_date AND tgt.end_date
   WHERE je.entry_date - bt.transaction_date = -1
     AND date_trunc('month', je.entry_date) <> date_trunc('month', bt.transaction_date)
     AND tgt.status = 'open';

  SELECT count(*) INTO v_before FROM tmp_522_targets;

  -- A journal reached through two bank transactions with DIFFERENT dates would
  -- make the new date arbitrary. Production has none; refuse rather than guess
  -- if that ever changes.
  IF EXISTS (
    SELECT 1 FROM tmp_522_targets GROUP BY journal_entry_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'migration 522: journal linked to bank transactions with differing dates; aborting';
  END IF;

  UPDATE gl_journal_entries je
     SET entry_date       = t.new_entry_date,
         fiscal_period_id = t.new_fiscal_period_id,
         updated_at       = now()
    FROM tmp_522_targets t
   WHERE je.id = t.journal_entry_id
     AND je.company_id = t.company_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RAISE NOTICE 'migration 522: % journals targeted, % re-dated', v_before, v_updated;

  IF v_updated <> v_before THEN
    RAISE EXCEPTION 'migration 522: expected % updates, applied %', v_before, v_updated;
  END IF;
END $$;
