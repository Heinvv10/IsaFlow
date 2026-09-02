-- 524 — the last 169 bank journals: move them to the date the SOURCE recorded.
--
-- Completes the work of 523. Between them they close out all 307 journals that
-- the pre-#276 UTC shift left in the wrong fiscal period.
--
-- WHY THESE COULD NOT BE DONE IN 523. That migration corrected only rows where
-- ABSA's embedded effective date ('EFFEC ddmmyyyy') corroborated the month.
-- These carry no usable effective date: 24 have the day and month masked by
-- the bank itself as 'EFFEC XXXX2023', and 146 are ACB debit orders, transfers,
-- fees and prepaid purchases, which never carry one. No amount of parsing
-- recovers a date that was never written.
--
-- WHY NOT THE BANK STATEMENTS. They are out of reach: ABSA's online history does
-- not reach back to 2022-2023, and no statement files survive anywhere in the
-- system (bank_statement_imports and bank_transaction_attachments are both 0
-- rows; only 2 of 307 rows carry an import_batch_id, and bank_import_batches
-- stores a filename, never the file).
--
-- WHY NOT SAGE. Sage holds the SAME collapsed dates — verified directly against
-- the original export (~/Downloads/sage-bank-transactions.json, 8,184 rows):
--
--     Sage rows dated 2022-11-01: 228     2022-12-01: 288     2023-01-01: 243
--
-- and spot-checked row by row (Sage 2022-04-01 'ACB DEBIT:EXTERNAL
-- ORGANICFIT168556559' == our transaction_date 2022-04-01). The month-collapsing
-- predates IsaFlow: whoever loaded these statements into Sage stamped each
-- monthly statement batch with a single date. Our import was faithful. Re-pulling
-- from Sage returns the identical dates.
--
-- WHAT IS ACTUALLY WRONG. The day is imprecise in every source, but the journal
-- date is worse than imprecise — it matches NOTHING:
--
--     bank transaction (= Sage)  2022-04-01
--     journal entry              2022-03-31   <- a month no source ever recorded
--
-- The journal sits one day earlier, in the PREVIOUS month, purely as output of
-- the toISOString() UTC shift that #276 fixed on the read side. So this is not a
-- choice between a fabricated date and a real one. It is a choice between the
-- month the source system recorded and a month this application invented.
--
-- Setting entry_date = transaction_date restores the month Sage held, which is
-- also the basis the historical VAT201s were filed on. (That last point is
-- inference, not verified: Brightsphere has ZERO vat_returns rows in IsaFlow
-- because those returns were filed out of Sage. Nothing covered by a non-draft
-- return is touched regardless, for every company.)
--
-- The day remains a statement-batch marker, not a real posting day. That is
-- unrecoverable and this migration does not pretend otherwise — it corrects the
-- period, nothing more.
--
-- DELIBERATELY EXCLUDED, both reported at run time: any journal whose old or new
-- date falls inside a FILED (non-draft) VAT return — today exactly one,
-- JE-2026-00390 on the demo tenant — and 15 journals whose effective date falls
-- in the month their entry_date ALREADY sits in — for those the current value is
-- correct and moving it would push them into the wrong month.
--
-- Re-running is a no-op: after the update entry_date = transaction_date.

DO $$
DECLARE
  v_targets integer;
  v_updated integer;
  v_bad     text;
BEGIN
  CREATE TEMP TABLE tmp_524 ON COMMIT DROP AS
  WITH linked AS (
    SELECT je.id            AS je_id,
           je.company_id,
           je.entry_number,
           je.status,
           je.entry_date    AS old_date,
           je.fiscal_period_id AS old_period,
           bt.transaction_date AS new_date,
           CASE
             WHEN bt.description ~ 'EFFEC [0-9]{8}'
               THEN to_date(substring(bt.description from 'EFFEC ([0-9]{8})'), 'DDMMYYYY')
             WHEN bt.description ~ 'EFF [0-9]{2}/[0-9]{2}/[0-9]{4}'
               THEN to_date(substring(bt.description from 'EFF ([0-9]{2}/[0-9]{2}/[0-9]{4})'), 'DD/MM/YYYY')
           END AS eff
      FROM bank_transactions bt
      JOIN gl_journal_lines jl
        ON jl.id = bt.matched_journal_line_id
       AND jl.company_id = bt.company_id
      JOIN gl_journal_entries je
        ON je.id = jl.journal_entry_id
       AND je.company_id = bt.company_id
     WHERE je.entry_date - bt.transaction_date = -1
       AND date_trunc('month', je.entry_date) <> date_trunc('month', bt.transaction_date)
  )
  SELECT DISTINCT
         l.je_id, l.company_id, l.entry_number, l.status,
         l.old_date, l.old_period, l.new_date, l.eff,
         tgt.id     AS new_period,
         tgt.status AS new_period_status,
         src.status AS old_period_status
    FROM linked l
    LEFT JOIN fiscal_periods tgt
      ON tgt.company_id = l.company_id
     AND l.new_date BETWEEN tgt.start_date AND tgt.end_date
    LEFT JOIN fiscal_periods src
      ON src.id = l.old_period
    -- Skip anything whose effective date vouches for the CURRENT month: there
    -- the existing entry_date is correct and moving it would be the error.
   WHERE (l.eff IS NULL
          OR date_trunc('month', l.eff) <> date_trunc('month', l.old_date))
     -- A journal inside a FILED VAT return is left exactly where it is. That is
     -- a property of the row's data, not a malformed request, so it is skipped
     -- and reported below rather than aborting the other 169 corrections. The
     -- invariant holds either way: nothing moves into or out of a filed period.
     AND NOT EXISTS (
       SELECT 1 FROM vat_returns vr
        WHERE vr.company_id = l.company_id
          AND vr.status <> 'draft'
          AND (l.old_date BETWEEN vr.period_start AND vr.period_end
            OR l.new_date BETWEEN vr.period_start AND vr.period_end)
     );

  SELECT count(*) INTO v_targets FROM tmp_524;

  -- Guards RAISE rather than filter: a target that stops qualifying is a change
  -- in the data a human must see, not a row to drop while the count still ties.

  SELECT string_agg(entry_number, ', ') INTO v_bad
    FROM tmp_524 WHERE new_period IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 524: no fiscal period covers the corrected date for: %', v_bad;
  END IF;

  SELECT string_agg(entry_number, ', ') INTO v_bad
    FROM tmp_524 WHERE new_period_status <> 'open' OR old_period_status <> 'open';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 524: source or target fiscal period is not open for: %', v_bad;
  END IF;

  SELECT string_agg(entry_number, ', ') INTO v_bad
    FROM tmp_524 WHERE status <> 'posted' OR old_period IS NULL OR old_period = new_period;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 524: unexpected journal state (not posted / null period / no period change): %', v_bad;
  END IF;

  SELECT string_agg(entry_number, ', ') INTO v_bad
    FROM (SELECT entry_number FROM tmp_524 GROUP BY je_id, entry_number HAVING count(*) > 1) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 524: journal linked to transactions with differing dates: %', v_bad;
  END IF;

  -- Report what was held back, so the skip is visible rather than silent.
  SELECT string_agg(je.entry_number, ', ') INTO v_bad
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = bt.company_id
    JOIN vat_returns vr ON vr.company_id = je.company_id AND vr.status <> 'draft'
     AND (je.entry_date BETWEEN vr.period_start AND vr.period_end
       OR bt.transaction_date BETWEEN vr.period_start AND vr.period_end)
   WHERE je.entry_date - bt.transaction_date = -1
     AND date_trunc('month', je.entry_date) <> date_trunc('month', bt.transaction_date);
  IF v_bad IS NOT NULL THEN
    RAISE NOTICE 'migration 524: LEFT ALONE, inside a filed VAT return: %', v_bad;
  END IF;

  -- Re-asserting old_date turns a concurrent re-date into a count mismatch
  -- rather than a silent lost update.
  UPDATE gl_journal_entries je
     SET entry_date       = t.new_date,
         fiscal_period_id = t.new_period,
         updated_at       = now()
    FROM tmp_524 t
   WHERE je.id = t.je_id
     AND je.company_id = t.company_id
     AND je.entry_date = t.old_date;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_targets THEN
    RAISE EXCEPTION 'migration 524: expected % updates, applied % (concurrent write?)', v_targets, v_updated;
  END IF;

  -- gl_account_balances is keyed (gl_account_id, fiscal_period_id) and is
  -- refreshed ONLY by trg_gl_je_status_balance — AFTER UPDATE OF status, guarded
  -- on a status change. Moving the period alone fires nothing, so the cache is
  -- rebuilt here for both the vacated and the receiving period.
  --
  -- The aggregate carries NO GROUP BY on purpose: it returns exactly one row even
  -- when no posted lines remain for an (account, period), so a vacated period is
  -- upserted to zero instead of keeping a stale value. A GROUP BY would emit no
  -- row and leave drift.
  INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
  SELECT p.gl_account_id, p.fiscal_period_id, agg.d, agg.c, agg.d - agg.c
    FROM (
      SELECT DISTINCT l.gl_account_id, u.per AS fiscal_period_id
        FROM tmp_524 t
        JOIN gl_journal_lines l ON l.journal_entry_id = t.je_id
        CROSS JOIN LATERAL unnest(ARRAY[t.old_period, t.new_period]) AS u(per)
    ) p
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(jl.debit), 0)  AS d,
             COALESCE(SUM(jl.credit), 0) AS c
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je2
          ON je2.id = jl.journal_entry_id
         AND je2.fiscal_period_id = p.fiscal_period_id
         AND je2.status = 'posted'
       WHERE jl.gl_account_id = p.gl_account_id
    ) agg
  ON CONFLICT (gl_account_id, fiscal_period_id) DO UPDATE SET
        debit_total  = EXCLUDED.debit_total,
        credit_total = EXCLUDED.credit_total,
        balance      = EXCLUDED.balance,
        updated_at   = NOW();

  -- Same corrections table 523 created; it is the only place the pre-correction
  -- entry_date survives. evidence_source records that this batch rests on the
  -- source system's date, NOT on a bank-supplied one.
  INSERT INTO gl_entry_date_corrections (
    company_id, journal_entry_id, entry_number, old_entry_date, new_entry_date,
    old_fiscal_period_id, new_fiscal_period_id, bank_transaction_date,
    evidence_date, evidence_source, migration)
  SELECT t.company_id, t.je_id, t.entry_number, t.old_date, t.new_date,
         t.old_period, t.new_period, t.new_date, NULL,
         'statement batch date as recorded by Sage and bank_transactions; exact day unrecoverable',
         '524'
    FROM tmp_524 t;

  RAISE NOTICE 'migration 524: % journals re-dated to the source date; gl_account_balances rebuilt', v_updated;
END $$;
