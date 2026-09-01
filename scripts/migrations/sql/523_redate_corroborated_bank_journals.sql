-- 523 — re-date the 122 bank journals whose month ABSA independently confirms.
--
-- BACKGROUND. Before #276 (99a61c90) bankRuleAutoPostLine derived a journal's
-- entry_date from bank_transactions.transaction_date via toISOString(). pg
-- returns a DATE (OID 1082) as a JS Date at LOCAL midnight, so on the UTC+2 box
-- that re-read as the PREVIOUS day and was then PERSISTED. #276 fixed the
-- reader; it could not un-write dates already stored. 2,476 journals (2,486
-- link rows — ten journals each link two transactions) are one day early, all
-- created 2026-04-05 -> 2026-06-09.
--
-- WHY THIS IS NOT A BLANKET FIX. 2,169 of those stay inside the correct month
-- and are cosmetic. Of the 307 that DO change fiscal period, none may be
-- corrected from transaction_date alone: a one-day shift can only cross a month
-- boundary when the corrected date is the 1st, and the 1st is precisely where
-- this tenant's bank dates are fabricated. ABSA embeds its own effective date in
-- the description ('EFFEC ddmmyyyy'); bucketed by day-of-month for Brightsphere:
--
--     bucket          rows  with_eff  avg(eff - transaction_date)  impossible(>=+2d)
--     dated 2nd-31st  7412      1323        -4.06 days                134 / 1323
--     dated 1st       1441       408       +11.89 days                344 /  408  (84%)
--
-- A bank cannot post a purchase before it happens, so an effective date AFTER
-- the stated posting date is impossible: rows dated the 1st are a synthetic
-- bucket from the 2026-04-24 Sage bulk load (215/274/231 rows dumped on
-- 2022-11-01 / 2022-12-01 / 2023-01-01, against ~1/day either side), not real
-- posting dates. transaction_date is therefore NOT authoritative here, and the
-- population-wide reference check (4,208 of 4,213 self-encoding 'YYYYMMDD-NNNN'
-- references agreeing, zero off by one) does not transfer to this subset — it is
-- dominated 7,412-to-1,441 by the reliable buckets.
--
-- WHAT THIS MIGRATION WRITES. Only rows where ABSA's own effective date -- text
-- the bank wrote, independent of our import -- agrees with transaction_date on
-- the month. For every such row the CURRENT entry_date is not merely doubtful,
-- it is impossible: it falls BEFORE the effective date, i.e. the journal is
-- dated before the card was swiped. Verified for all 122.
--
-- entry_date is set to the EFFECTIVE date, not to transaction_date. Both resolve
-- to the same fiscal period (the filter requires the same month, and periods
-- here are calendar months), so this changes no period, no VAT return and no
-- year-end -- only the day. But transaction_date on the 1st is the fabricated
-- value this file has just finished disproving, while the effective date is the
-- one real date ABSA supplied. Writing the invented day and filing the real one
-- as "evidence" would be backwards. The fabricated value is kept in
-- gl_entry_date_corrections.bank_transaction_date for traceability.
--
-- An earlier draft excluded effective dates within 3 days of month end, to guard
-- against the true posting spilling into the next month. That guard is dropped:
-- it was justified by a "~4-day average lag" the data contradicts (real lag on
-- trustworthy rows is p50 3, p90 14, p95 18, max 23 days -- the mean was
-- contaminated by the impossible negatives), and once entry_date IS the
-- effective date the period follows from it by definition and there is no
-- overshoot left to guard. It was excluding 2 rows.
--
-- Deliberately untouched, and why:
--   * 15 rows whose effective date matches the CURRENT entry_date month — for
--     these the existing value is the better one; re-dating would move them INTO
--     the wrong month.
--   * 170 rows with no independent evidence (85 carry only a same-import
--     reference, 85 nothing at all). They need the ABSA statements. See
--     /home/hein/Workspace/isaflow-je-date-quarantine/.
--   * 2,169 cosmetic within-month rows — no period consequence.
--
-- Re-running is a no-op: after the update entry_date = transaction_date, so the
-- '-1' predicate matches nothing.

DO $$
DECLARE
  v_targets integer;
  v_updated integer;
  v_bad     text;
BEGIN
  CREATE TEMP TABLE tmp_523 ON COMMIT DROP AS
  WITH linked AS (
    SELECT je.id            AS je_id,
           je.company_id,
           je.entry_number,
           je.status,
           je.entry_date    AS old_date,
           je.fiscal_period_id AS old_period,
           bt.transaction_date AS bank_date,
           CASE
             WHEN bt.description ~ 'EFFEC ([0-9]{8})'
               THEN to_date(substring(bt.description from 'EFFEC ([0-9]{8})'), 'DDMMYYYY')
             WHEN bt.description ~ 'EFF ([0-9]{2}/[0-9]{2}/[0-9]{4})'
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
         l.old_date, l.old_period, l.bank_date,
         l.eff      AS new_date,
         tgt.id     AS new_period,
         tgt.status AS new_period_status,
         src.status AS old_period_status
    FROM linked l
    -- The period is resolved from the EFFECTIVE date, which is the value being
    -- written. Resolving it from bank_date would tie the period to a day this
    -- migration has just finished proving is fabricated.
    LEFT JOIN fiscal_periods tgt
      ON tgt.company_id = l.company_id
     AND l.eff BETWEEN tgt.start_date AND tgt.end_date
    LEFT JOIN fiscal_periods src
      ON src.id = l.old_period
   WHERE l.eff IS NOT NULL
     -- Corroboration: ABSA's effective date and the (otherwise untrusted) bank
     -- date agree on the month. Rows where the effective date instead matches
     -- the CURRENT entry_date month are excluded by this and must stay as they
     -- are -- for those the existing value is the correct one.
     AND date_trunc('month', l.eff) = date_trunc('month', l.bank_date);

  SELECT count(*) INTO v_targets FROM tmp_523;

  -- Guards. Each RAISEs rather than silently filtering: a target that no longer
  -- qualifies is a change in the data that a human must look at, not a row to
  -- quietly drop while the summary still reads "N targeted, N updated".

  SELECT string_agg(entry_number, ', ') INTO v_bad
    FROM tmp_523 WHERE new_period IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 523: no fiscal period covers the corrected date for: %', v_bad;
  END IF;

  SELECT string_agg(entry_number, ', ') INTO v_bad
    FROM tmp_523 WHERE new_period_status <> 'open' OR old_period_status <> 'open';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 523: source or target fiscal period is not open for: %', v_bad;
  END IF;

  SELECT string_agg(entry_number, ', ') INTO v_bad
    FROM tmp_523 WHERE status <> 'posted' OR old_period IS NULL OR old_period = new_period;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 523: unexpected journal state (not posted / null period / no period change): %', v_bad;
  END IF;

  -- A journal reached through two bank transactions with DIFFERENT dates would
  -- make the corrected date arbitrary.
  SELECT string_agg(entry_number, ', ') INTO v_bad
    FROM (SELECT entry_number FROM tmp_523 GROUP BY je_id, entry_number HAVING count(*) > 1) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 523: journal linked to transactions with differing dates: %', v_bad;
  END IF;

  -- Never move a journal into or out of a VAT period that has been filed.
  -- Checked across EVERY affected company, not just the largest one.
  SELECT string_agg(t.entry_number, ', ') INTO v_bad
    FROM tmp_523 t
    JOIN vat_returns vr
      ON vr.company_id = t.company_id
     AND vr.status <> 'draft'
     AND (t.old_date BETWEEN vr.period_start AND vr.period_end
       OR t.new_date BETWEEN vr.period_start AND vr.period_end);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'migration 523: would re-date a journal inside a filed VAT return: %', v_bad;
  END IF;

  -- The UPDATE re-asserts old_date so a concurrent re-date becomes a no-op
  -- (row count mismatch below) rather than a silent lost update.
  UPDATE gl_journal_entries je
     SET entry_date       = t.new_date,
         fiscal_period_id = t.new_period,
         updated_at       = now()
    FROM tmp_523 t
   WHERE je.id = t.je_id
     AND je.company_id = t.company_id
     AND je.entry_date = t.old_date;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_targets THEN
    RAISE EXCEPTION 'migration 523: expected % updates, applied % (concurrent write?)', v_targets, v_updated;
  END IF;

  -- gl_account_balances is keyed (gl_account_id, fiscal_period_id) and is
  -- maintained ONLY by trg_gl_je_status_balance, which is AFTER UPDATE OF status
  -- with a WHEN (old.status IS DISTINCT FROM new.status) guard. Moving the
  -- period without moving status fires nothing, so the cache must be rebuilt
  -- here for BOTH the vacated and the receiving period. Same recompute the
  -- trigger function performs. Without this the cache silently drifts.
  INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
  SELECT p.gl_account_id, p.fiscal_period_id, agg.d, agg.c, agg.d - agg.c
    FROM (
      SELECT DISTINCT l.gl_account_id, u.per AS fiscal_period_id
        FROM tmp_523 t
        JOIN gl_journal_lines l ON l.journal_entry_id = t.je_id
        CROSS JOIN LATERAL unnest(ARRAY[t.old_period, t.new_period]) AS u(per)
    ) p
    CROSS JOIN LATERAL (
      -- Aggregate with NO GROUP BY: it returns exactly one row even when no
      -- posted lines remain for this (account, period), so a period that has
      -- just been vacated is upserted to zero rather than keeping a stale
      -- value. A GROUP BY here would emit no row and silently leave drift.
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

  -- Audit trail. audit_log.user_id is FK'd to users, and attributing 120
  -- machine edits to a real person's account would misrepresent who made them,
  -- so the record lives in its own table. It is the ONLY place the pre-
  -- correction entry_date survives.
  CREATE TABLE IF NOT EXISTS gl_entry_date_corrections (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES companies(id),
    journal_entry_id    uuid NOT NULL REFERENCES gl_journal_entries(id),
    entry_number        varchar(50),
    old_entry_date      date NOT NULL,
    new_entry_date      date NOT NULL,
    old_fiscal_period_id uuid REFERENCES fiscal_periods(id),
    new_fiscal_period_id uuid REFERENCES fiscal_periods(id),
    bank_transaction_date date,
    evidence_date       date,
    evidence_source     text NOT NULL,
    migration           text NOT NULL,
    corrected_at        timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_gl_entry_date_corr_company
    ON gl_entry_date_corrections (company_id);
  CREATE INDEX IF NOT EXISTS idx_gl_entry_date_corr_je
    ON gl_entry_date_corrections (journal_entry_id);

  -- Tenant isolation, matching every sibling tenant-scoped table (gl_journal_
  -- entries, gl_journal_lines, fiscal_periods, vat_returns all FORCE RLS with
  -- this policy). The table is created here and inherits nothing later, so the
  -- policy has to be established in the same migration or it never exists.
  ALTER TABLE gl_entry_date_corrections ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gl_entry_date_corrections FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'gl_entry_date_corrections'::regclass
       AND polname  = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON gl_entry_date_corrections
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id());
  END IF;

  INSERT INTO gl_entry_date_corrections (
    company_id, journal_entry_id, entry_number, old_entry_date, new_entry_date,
    old_fiscal_period_id, new_fiscal_period_id, bank_transaction_date,
    evidence_date, evidence_source, migration)
  SELECT t.company_id, t.je_id, t.entry_number, t.old_date, t.new_date,
         t.old_period, t.new_period, t.bank_date, t.new_date,
         'ABSA effective date embedded in bank_transactions.description', '523'
    FROM tmp_523 t;

  RAISE NOTICE 'migration 523: % journals re-dated; gl_account_balances rebuilt and gl_entry_date_corrections written', v_updated;
END $$;
