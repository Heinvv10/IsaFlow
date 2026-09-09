-- 659_loan_reclass_postings_backfill_rebuild.sql
--
-- K-081 review round 2: H1 / M3 / L3 / L4. Rebuilds every row migration 645's
-- backfill reconstructed, because that reconstruction identified a loan by
-- REBUILDING ITS NARRATIVE STRING and neither half of the key is unique:
--
--   H1  the join is
--         je.description = 'Reclassification – loan ' || COALESCE(l.reference, l.id::text) || ' for ' || yyyymm
--       plus l.current_portion_account_id = jl.gl_account_id. `loans.reference`
--       has no unique constraint and one current-portion account normally
--       serves every loan in the company, so two loans sharing a reference each
--       absorbed the other's journals. Reproduced on the schema fixture: loans
--       A and B both `reference = 'LN-1'`, ONE posted journal for A, backfill
--       wrote 202602 = 100 000 for BOTH. closeLoanPeriod then reads that as B's
--       prior and journals `stLiability_B − 100 000` to the general ledger —
--       a fabricated movement, posted silently.
--   M3  two reclass journals in one month produced two peer rows with the same
--       ORDER BY key, so the running sum gave each a different total in
--       unspecified order and ON CONFLICT DO NOTHING kept whichever landed
--       first. Fixture: journals of 100 000 and 92 000 in 202602 recorded
--       92 000 against a GL balance of 192 000.
--   L3  the account join used the loan's CURRENT current_portion_account_id, so
--       a loan re-pointed after a close matched nothing and silently got a zero
--       prior.
--   L4  a GL reversal is a separate entry (`Reversal of <number>`) and leaves
--       the original at status='posted' with `reversed_at` set, so a reversed
--       reclass was still counted at full value.
--
-- WHAT THIS DOES DIFFERENTLY
--   * Resolves the loan by its own identity: the narrative key is extracted
--     from the description and matched against COALESCE(reference, id::text)
--     over every loan in the company. A key matching two loans, or none, is
--     REFUSED — never guessed — and named in a WARNING for a human to resolve.
--     A refused loan gets no row, so its next close reclassifies the full
--     current portion (an overstatement a human can see and correct) rather
--     than a fabricated movement nobody can.
--   * Aggregates every journal in a month before the running sum (M3).
--   * Refuses a loan whose current-portion account holds no line on one of its
--     own reclass journals — that is a re-pointed account and the running sum
--     would be missing a period (L3).
--   * Ignores reversed entries (L4).
--   * company_id is bound as a plpgsql variable and repeated on EVERY join and
--     predicate of every statement, DELETE included.
--
-- WHY A REBUILD RATHER THAN A PATCH: 645 and this migration ship in the same
-- unmerged branch, so 645's backfill has never run anywhere but a disposable
-- fixture and no close has ever written to this table. The per-tenant guard
-- inside the loop makes that assumption fail closed instead of silently:
-- closeLoanPeriod always inserts a loan_period_locks row, so a lock at or
-- after that company's earliest row means the application has written here
-- since the backfill, and this migration aborts — naming the tenant — rather
-- than deleting real postings.
--
-- Rollback: none needed — the table is reconstructed from posted GL journals,
-- so re-running this block is a no-op on an unchanged ledger.

DO $$
DECLARE
  target_company UUID;
  inserted_rows  BIGINT;
  total_rows     BIGINT := 0;
  refused        TEXT;
BEGIN
  CREATE TEMP TABLE tmp_k081_journals (
    je_id      UUID,
    created_at TIMESTAMPTZ,
    yyyymm     CHAR(6),
    loan_key   TEXT,
    loan_id    UUID,
    n_loans    BIGINT,
    cp_lines   BIGINT,
    net_credit NUMERIC(18,2)
  );

  FOR target_company IN
    SELECT DISTINCT company_id FROM loans
  LOOP
    TRUNCATE tmp_k081_journals;

    -- Fail closed, per tenant. closeLoanPeriod always writes a
    -- loan_period_locks row, so a lock at or after this company's earliest
    -- loan_reclass_postings row means the application has written here since
    -- the backfill and the DELETE below would destroy a real posting. Abort
    -- and name the tenant rather than guess.
    IF EXISTS (
      SELECT 1 FROM loan_period_locks lk
       WHERE lk.company_id = target_company
         AND lk.locked_at >= (SELECT MIN(created_at) FROM loan_reclass_postings
                               WHERE company_id = target_company)
    ) THEN
      RAISE EXCEPTION
        'loan_reclass_postings holds rows for company % written after a loan period close; refusing to rebuild the backfill. See docs/audits/remediation/K-081/fix.md.',
        target_company;
    END IF;

    -- Candidate journals, with the loan key read OUT of the narrative rather
    -- than a narrative rebuilt from a loan. ' for YYYYMM' is 11 characters and
    -- 'Reclassification – loan ' is 24, so the key is what lies between them —
    -- correct even when the reference itself contains ' for '.
    INSERT INTO tmp_k081_journals (je_id, created_at, yyyymm, loan_key)
    SELECT je.id, je.created_at, RIGHT(je.description, 6),
           SUBSTRING(je.description FROM 25 FOR LENGTH(je.description) - 35)
      FROM gl_journal_entries je
     WHERE je.company_id = target_company
       AND je.status = 'posted'
       AND je.reversed_at IS NULL
       AND je.description LIKE 'Reclassification – loan % for %'
       AND LENGTH(je.description) > 35
       AND RIGHT(je.description, 6) ~ '^[0-9]{6}$'
       AND SUBSTRING(je.description FROM LENGTH(je.description) - 10) =
           ' for ' || RIGHT(je.description, 6);

    -- Resolve the key against this company's loans. n_loans <> 1 is refused.
    UPDATE tmp_k081_journals t
       SET n_loans = m.n_loans,
           loan_id = m.only_loan
      FROM (
        SELECT k.loan_key,
               COUNT(DISTINCT l.id)                              AS n_loans,
               (ARRAY_AGG(l.id) FILTER (WHERE l.id IS NOT NULL))[1] AS only_loan
          FROM (SELECT DISTINCT loan_key FROM tmp_k081_journals) k
          LEFT JOIN loans l
            ON l.company_id = target_company
           AND COALESCE(l.reference, l.id::text) = k.loan_key
         GROUP BY k.loan_key
      ) m
     WHERE m.loan_key = t.loan_key;

    -- Net credit to the resolved loan's own current-portion account, and how
    -- many lines that account holds on the journal (0 = re-pointed, L3).
    UPDATE tmp_k081_journals t
       SET cp_lines   = a.cp_lines,
           net_credit = a.net_credit
      FROM (
        SELECT t2.je_id,
               COUNT(jl.id) FILTER (WHERE jl.gl_account_id = l.current_portion_account_id) AS cp_lines,
               COALESCE(SUM(jl.credit - jl.debit)
                        FILTER (WHERE jl.gl_account_id = l.current_portion_account_id), 0)  AS net_credit
          FROM tmp_k081_journals t2
          JOIN loans l
            ON l.id = t2.loan_id AND l.company_id = target_company
          JOIN gl_journal_lines jl
            ON jl.journal_entry_id = t2.je_id AND jl.company_id = target_company
         WHERE t2.n_loans = 1
         GROUP BY t2.je_id
      ) a
     WHERE a.je_id = t.je_id;

    SELECT string_agg(line, E'\n') INTO refused FROM (
      SELECT DISTINCT
             format('company_id=%s loan_key=%s reason=%s', target_company, loan_key,
                    CASE WHEN n_loans = 0 THEN 'no loan carries this reference'
                         WHEN n_loans > 1 THEN 'reference is shared by ' || n_loans || ' loans'
                         ELSE 'current-portion account was re-pointed after the close' END) AS line
        FROM tmp_k081_journals
       WHERE n_loans <> 1
          OR loan_id IN (SELECT loan_id FROM tmp_k081_journals WHERE n_loans = 1 AND cp_lines = 0)
    ) r;
    IF refused IS NOT NULL THEN
      RAISE WARNING E'loan_reclass_postings backfill refused to reconstruct these loans; their next close reclassifies the full current portion, so correct them by hand (see docs/audits/remediation/K-081/fix.md):\n%', refused;
    END IF;

    DELETE FROM loan_reclass_postings WHERE company_id = target_company;

    INSERT INTO loan_reclass_postings (company_id, loan_id, yyyymm, st_liability, journal_entry_id)
    SELECT target_company, loan_id, yyyymm,
           SUM(month_credit) OVER (
             PARTITION BY loan_id ORDER BY yyyymm
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ),
           journal_entry_id
      FROM (
        SELECT t.loan_id,
               t.yyyymm,
               SUM(t.net_credit)                                       AS month_credit,
               (ARRAY_AGG(t.je_id ORDER BY t.created_at, t.je_id))[1]  AS journal_entry_id
          FROM tmp_k081_journals t
         WHERE t.n_loans = 1
           AND t.loan_id NOT IN (
                 SELECT loan_id FROM tmp_k081_journals WHERE n_loans = 1 AND cp_lines = 0
               )
         GROUP BY t.loan_id, t.yyyymm
      ) per_month
    ON CONFLICT (company_id, loan_id, yyyymm) DO NOTHING;

    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    total_rows := total_rows + inserted_rows;
  END LOOP;

  DROP TABLE tmp_k081_journals;

  RAISE NOTICE 'loan_reclass_postings rebuilt: % row(s) reconstructed from posted reclass journals', total_rows;
END $$;
