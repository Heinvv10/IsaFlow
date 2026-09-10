-- 659_loan_reclass_postings_backfill_rebuild.sql
--
-- K-081 review round 2 (H1 / M3 / L3 / L4) and round 3 (H1 / M1 / M2 / M3 / M5
-- / L6). Rebuilds every row migration 645's backfill reconstructed, because
-- that reconstruction identified a loan by REBUILDING ITS NARRATIVE STRING and
-- neither half of the key is unique:
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
--     REFUSED — never guessed, and a key that names exactly ONE loan is
--     confirmed against that loan's own schedule before any row is written
--     (round-6 M1 below). A refused loan gets no row, so its next close
--     reclassifies the full current portion (an overstatement a human can see
--     and correct) rather than a fabricated movement nobody can.
--   * Records every refusal in `loan_reclass_backfill_refusals`, a durable
--     table, as well as raising a WARNING (round-3 H1: the runner used to
--     discard notices, and deploy console output scrolls past in any case).
--   * Selects candidates on a LOOSE description pattern and refuses — with a
--     named reason — anything the strict parse rejects, instead of dropping it
--     silently (round-3 M3). An empty `reference` now parses correctly.
--   * Aggregates every journal in a month before the running sum (M3).
--   * Refuses a loan whose current-portion account holds no line on one of its
--     own reclass journals — that is a re-pointed account and the running sum
--     would be missing a period (L3).
--   * Refuses a loan whose history a refusal has PUNCHED A HOLE IN (round-5
--     M1). Resolution is per journal, so a loan could be refused for its
--     202602 journal and reconstructed from its 202603 one — the running sum
--     then starts mid-history and the recorded prior is lower than what the
--     current-portion account actually holds. `updateLoan` writes
--     `reference = COALESCE(…, reference)`, so a rename between two closes is
--     reachable from the API and produces exactly that. Two ways a hole
--     reaches a loan, both refused rather than reconstructed:
--     A hole reaches a loan when a journal that could not be attributed to ANY
--     loan (unparsed, or a key no loan carries) moved THIS loan's
--     current-portion account: a renamed reference is indistinguishable from a
--     foreign journal, so the conservative reading is that the movement was
--     this loan's. Refusing costs an overstatement at the next close that a
--     human can see; reconstructing costs a fabricated movement nobody can.
--   * VALIDATES EVERY RECONSTRUCTED FIGURE AGAINST THE LOAN'S OWN SCHEDULE
--     (round-6 M1). Resolving a key that names exactly one loan is still a
--     guess: `loans.reference` is mutable and carries no unique constraint, so
--     two loans that SWAP references — or a reference REUSED by a second loan
--     after the first was renamed — each resolve cleanly to the WRONG loan.
--     Nothing is unattributable and no key is ambiguous, so neither taint rule
--     above fires, and the per-account totals foot identically under either
--     attribution, so no balance check can see it either. Reproduced on the
--     fixture: a swap moved 60 000 of one loan's prior onto the other, which
--     the next close would have journalled as a fabricated movement.
--     Three rounds have each found a new way for a mutable text key to
--     mis-attribute history, so this no longer tries to anticipate the fourth.
--     `recordReclass` writes the schedule row's `st_liability`, and the running
--     sum of the movements up to a month IS that month's `st_liability`, so the
--     schedule is an oracle the narrative key never touches. Every
--     reconstructed figure is checked against the loan's OWN
--     `loan_schedule_rows.st_liability` for that month, over every run the loan
--     has (a reprice restates the month in later runs, so agreement with ANY
--     run is agreement). A loan with one period the schedule does not confirm —
--     including a period it has no schedule row for — is refused whole.
--     Attribution is decided by OUTCOME, not by the key that produced it.
--     THE COST: a loan whose schedule cache no longer covers a month it was
--     closed in is refused even though its reconstruction may be right. The
--     remedy is the same for every refusal — record the true prior by hand in
--     `loan_reclass_postings` with source = 'app', which this rebuild never
--     deletes.
--   * Ignores reversed entries (L4).
--   * company_id is bound as a plpgsql variable and repeated on EVERY join and
--     predicate of every statement, DELETE included.
--
-- WHY A REBUILD RATHER THAN A PATCH: 645 and this migration ship in the same
-- unmerged branch, so 645's backfill has never run anywhere but a disposable
-- fixture and no close has ever written to this table (confirmed: no 64x/65x
-- row in schema_migrations on isaflow_dev, and production is behind this
-- branch). `loan_reclass_postings.source` records which writer produced a row,
-- every row that predates this migration is therefore stamped 'backfill', and
-- the rebuild deletes ONLY its own rows. Rows the application wrote are never
-- touched, so the round-2 per-tenant abort is gone — with it the two ways it
-- misfired (round-3 M1: it made the documented "re-run 659 for that tenant"
-- recovery impossible the first time anyone closed a period; round-3 M5: a
-- close that reclassified nothing still tripped it and aborted every OTHER
-- tenant's rebuild too).
--
-- ROLE: the DELETE/INSERT below target a FORCE ROW LEVEL SECURITY table whose
-- only policy is TO app_user (round-3 L4). FORCE binds the owner as well, so
-- this must run as a superuser or a BYPASSRLS role — the role behind
-- DATABASE_URL in scripts/deploy.sh. The guard at the top of the rebuild block
-- refuses rather than silently matching zero rows.
--
-- Rollback: none needed — the table is reconstructed from posted GL journals,
-- so re-running this block is a no-op on an unchanged ledger.

-- ── source column: which writer produced each row ──────────────────────────
-- Idempotent by construction: the stamp of existing rows to 'backfill' runs
-- only on the branch that adds the column, so a second run cannot restamp a
-- row the application wrote.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'loan_reclass_postings' AND column_name = 'source'
  ) THEN
    ALTER TABLE loan_reclass_postings ADD COLUMN source TEXT NOT NULL DEFAULT 'backfill';
    ALTER TABLE loan_reclass_postings ALTER COLUMN source SET DEFAULT 'app';
    ALTER TABLE loan_reclass_postings
      ADD CONSTRAINT loan_reclass_postings_source_check CHECK (source IN ('app', 'backfill'));
  END IF;
END $$;

-- ── durable record of what the rebuild refused ─────────────────────────────
CREATE TABLE IF NOT EXISTS loan_reclass_backfill_refusals (
  company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal_entry_id UUID        NOT NULL REFERENCES gl_journal_entries(id) ON DELETE CASCADE,
  loan_key         TEXT,
  yyyymm           CHAR(6),
  description      TEXT        NOT NULL,
  reason           TEXT        NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, journal_entry_id)
);

ALTER TABLE loan_reclass_backfill_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_reclass_backfill_refusals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON loan_reclass_backfill_refusals;
CREATE POLICY tenant_isolation ON loan_reclass_backfill_refusals
  FOR SELECT
  TO app_user
  USING (company_id IN (SELECT auth.user_companies()));

GRANT SELECT ON loan_reclass_backfill_refusals TO app_user;

DO $$
DECLARE
  target_company UUID;
  inserted_rows  BIGINT;
  total_rows     BIGINT := 0;
  refused        TEXT;
  refused_total  BIGINT;
BEGIN
  -- FORCE ROW LEVEL SECURITY applies to the table owner too, so only a
  -- superuser or a BYPASSRLS role can DELETE/INSERT here without the app_user
  -- policy. Refuse loudly rather than match zero rows in silence.
  IF NOT (current_setting('is_superuser') = 'on'
          OR COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)) THEN
    RAISE EXCEPTION
      'role % is neither superuser nor BYPASSRLS; loan_reclass_postings FORCEs row level security, so this rebuild would silently match zero rows. See the ROLE note in this file.',
      current_user;
  END IF;

  -- Round-5 M1. Loans whose reconstructed history has a hole in it. Refusal is
  -- decided per JOURNAL above; this carries the consequence to the LOAN, so a
  -- loan can never be rebuilt from only the part of its history that resolved.
  CREATE TEMP TABLE tmp_k081_tainted (
    loan_id UUID PRIMARY KEY,
    reason  TEXT NOT NULL
  );

  -- Round-6 M1. What the rebuild WOULD write, held back until the loan's own
  -- schedule confirms it.
  CREATE TEMP TABLE tmp_k081_recon (
    loan_id          UUID,
    yyyymm           CHAR(6),
    st_liability     NUMERIC(18,2),
    journal_entry_id UUID
  );

  CREATE TEMP TABLE tmp_k081_journals (
    je_id       UUID,
    created_at  TIMESTAMPTZ,
    description TEXT,
    parsed      BOOLEAN,
    yyyymm      CHAR(6),
    loan_key    TEXT,
    loan_id     UUID,
    n_loans     BIGINT,
    cp_lines    BIGINT,
    net_credit  NUMERIC(18,2)
  );

  -- Round-4 L4. Driving this from `loans` alone would never revisit a company
  -- whose last loan was deleted: its refusal rows from an earlier run would
  -- read as current when they are not, and any reclass journal it still holds
  -- would be neither reconstructed nor refused. The refusals table is
  -- presented as the authoritative record of what was skipped, so every
  -- company that has one is revisited too.
  FOR target_company IN
    SELECT company_id FROM loans
    UNION
    SELECT company_id FROM loan_reclass_backfill_refusals
  LOOP
    TRUNCATE tmp_k081_journals;
    TRUNCATE tmp_k081_tainted;
    TRUNCATE tmp_k081_recon;

    -- Candidate journals on the LOOSE pattern, with the loan key read OUT of
    -- the narrative rather than a narrative rebuilt from a loan.
    -- ' for YYYYMM' is 11 characters and 'Reclassification – loan ' is 24, so
    -- the key is what lies between them — correct even when the reference
    -- itself contains ' for ', and correct (empty) when it is ''.
    -- Anything the strict parse rejects is kept with parsed=false and reported
    -- as a refusal below, never dropped (round-3 M3).
    INSERT INTO tmp_k081_journals (je_id, created_at, description, parsed, yyyymm, loan_key)
    SELECT je.id, je.created_at, je.description, p.parsed,
           CASE WHEN p.parsed THEN RIGHT(je.description, 6) END,
           CASE WHEN p.parsed THEN SUBSTRING(je.description FROM 25 FOR LENGTH(je.description) - 35) END
      FROM gl_journal_entries je
      CROSS JOIN LATERAL (
        SELECT (je.description LIKE 'Reclassification – loan % for %'
                AND LENGTH(je.description) >= 35
                AND RIGHT(je.description, 6) ~ '^[0-9]{6}$'
                AND SUBSTRING(je.description FROM LENGTH(je.description) - 10) =
                    ' for ' || RIGHT(je.description, 6)) AS parsed
      ) p
     WHERE je.company_id = target_company
       AND je.status = 'posted'
       AND je.reversed_at IS NULL
       AND je.description LIKE 'Reclassification%loan%';

    -- Resolve the key against this company's loans. n_loans <> 1 is refused.
    UPDATE tmp_k081_journals t
       SET n_loans = m.n_loans,
           loan_id = m.only_loan
      FROM (
        SELECT k.loan_key,
               COUNT(DISTINCT l.id)                              AS n_loans,
               (ARRAY_AGG(l.id) FILTER (WHERE l.id IS NOT NULL))[1] AS only_loan
          FROM (SELECT DISTINCT loan_key FROM tmp_k081_journals WHERE parsed) k
          LEFT JOIN loans l
            ON l.company_id = target_company
           AND COALESCE(l.reference, l.id::text) = k.loan_key
         GROUP BY k.loan_key
      ) m
     WHERE m.loan_key = t.loan_key AND t.parsed;

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

    -- ── Round-5 M1: carry each refusal from the journal to the loan ────────
    -- Insertion order is the reason precedence: the first reason recorded for
    -- a loan wins, and the re-pointed account is the most specific of them.
    INSERT INTO tmp_k081_tainted (loan_id, reason)
    SELECT DISTINCT t.loan_id, 'current-portion account was re-pointed after the close'
      FROM tmp_k081_journals t
     WHERE t.n_loans = 1 AND COALESCE(t.cp_lines, 0) = 0
    ON CONFLICT (loan_id) DO NOTHING;

    -- A key naming several loans needs no entry here: a loan's key is the
    -- single-valued COALESCE(reference, id::text), so every journal of an
    -- ambiguous loan carries that same ambiguous key and is already excluded
    -- by n_loans <> 1. A loan cannot be ambiguous under one key and resolvable
    -- under another.
    --
    -- A journal that belongs to no loan we can name, on a loan's OWN
    -- current-portion account. A reference renamed between two closes lands
    -- here, and is indistinguishable from a foreign journal.
    INSERT INTO tmp_k081_tainted (loan_id, reason)
    SELECT DISTINCT l.id,
           'an unattributable reclass journal moved this loan''s current-portion account, so its reconstructed prior would start mid-history'
      FROM tmp_k081_journals t
      JOIN loans l ON l.company_id = target_company
     WHERE (NOT t.parsed OR t.n_loans = 0)
       -- Round-6 L1. A reclass journal moves the loan's current-portion account
       -- AND its long-term account. Matching the current-portion account alone
       -- also tainted every loan whose current-portion account happened to be
       -- the CONTRA leg of the orphan — wider than the documented rule.
       AND EXISTS (
         SELECT 1 FROM gl_journal_lines jl
          WHERE jl.journal_entry_id = t.je_id AND jl.company_id = target_company
            AND jl.gl_account_id = l.current_portion_account_id)
       AND EXISTS (
         SELECT 1 FROM gl_journal_lines jl
          WHERE jl.journal_entry_id = t.je_id AND jl.company_id = target_company
            AND jl.gl_account_id = l.gl_account_id)
    ON CONFLICT (loan_id) DO NOTHING;

    -- ── Round-6 M1: reconstruct first, then confirm against the schedule ────
    INSERT INTO tmp_k081_recon (loan_id, yyyymm, st_liability, journal_entry_id)
    SELECT loan_id, yyyymm,
           SUM(month_credit) OVER (
             PARTITION BY loan_id ORDER BY yyyymm
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ),
           journal_entry_id
      FROM (
        SELECT t.loan_id,
               t.yyyymm,
               SUM(t.net_credit)                                      AS month_credit,
               (ARRAY_AGG(t.je_id ORDER BY t.created_at, t.je_id))[1] AS journal_entry_id
          FROM tmp_k081_journals t
         WHERE t.parsed AND t.n_loans = 1
         GROUP BY t.loan_id, t.yyyymm
      ) per_month;

    -- The oracle: `recordReclass` writes the schedule row's st_liability, and
    -- the running sum above is exactly that figure. A reprice restates the
    -- month in every later run, so agreement with ANY of this loan's own runs
    -- is agreement; a month no run of it confirms means the key that produced
    -- the figure may name a different loan (a swapped or reused reference),
    -- which no total will ever disagree with once the row is written.
    INSERT INTO tmp_k081_tainted (loan_id, reason)
    SELECT DISTINCT r.loan_id,
           'no schedule run of this loan confirms the reconstructed current portion for one of its periods, so the narrative key may name a different loan'
      FROM tmp_k081_recon r
     WHERE NOT EXISTS (
       SELECT 1
         FROM loan_schedule_runs run
         JOIN loan_schedule_rows lsr ON lsr.run_id = run.id
        WHERE run.loan_id = r.loan_id
          AND run.company_id = target_company
          AND TO_CHAR(lsr.date, 'YYYYMM') = r.yyyymm
          AND ABS(COALESCE(lsr.st_liability, 0) - r.st_liability) <= 0.01
     )
    ON CONFLICT (loan_id) DO NOTHING;

    -- Durable refusal record, rebuilt for this tenant on every run so it can
    -- never disagree with the rows that were (not) reconstructed.
    DELETE FROM loan_reclass_backfill_refusals WHERE company_id = target_company;

    INSERT INTO loan_reclass_backfill_refusals
      (company_id, journal_entry_id, loan_key, yyyymm, description, reason)
    SELECT target_company, t.je_id, t.loan_key, t.yyyymm, t.description,
           CASE WHEN NOT t.parsed  THEN 'description does not parse into a loan key and period'
                WHEN t.n_loans = 0 THEN 'no loan carries this reference'
                WHEN t.n_loans > 1 THEN 'reference is shared by ' || t.n_loans || ' loans'
                ELSE tt.reason END
      FROM tmp_k081_journals t
      LEFT JOIN tmp_k081_tainted tt ON tt.loan_id = t.loan_id
     WHERE NOT t.parsed
        OR t.n_loans <> 1
        OR tt.loan_id IS NOT NULL;

    -- Round-4 L3. DISTINCT bounds this by distinct loan keys rather than by
    -- journals, but a tenant with thousands of unresolvable references would
    -- still build one multi-thousand-line string in memory and print it line
    -- by line. Show the first 50 and point at the durable table for the rest.
    SELECT COUNT(*) INTO refused_total FROM (
      SELECT DISTINCT format('company_id=%s loan_key=%s reason=%s',
                             target_company, COALESCE(loan_key, '(unparsed)'), reason) AS line
        FROM loan_reclass_backfill_refusals
       WHERE company_id = target_company
    ) r;
    SELECT string_agg(line, E'\n') INTO refused FROM (
      SELECT DISTINCT format('company_id=%s loan_key=%s reason=%s',
                             target_company, COALESCE(loan_key, '(unparsed)'), reason) AS line
        FROM loan_reclass_backfill_refusals
       WHERE company_id = target_company
       ORDER BY 1
       LIMIT 50
    ) r;
    IF refused IS NOT NULL THEN
      IF refused_total > 50 THEN
        refused := refused || format(E'\n… and %s more; see loan_reclass_backfill_refusals',
                                     refused_total - 50);
      END IF;
      RAISE WARNING E'loan_reclass_postings backfill refused to reconstruct these loans; their next close reclassifies the full current portion, so correct them by hand — record the true prior in loan_reclass_postings with source = ''app'', which this rebuild never deletes — and re-run this migration (see docs/audits/remediation/K-081/fix.md). Every refusal is also a row in loan_reclass_backfill_refusals:\n%', refused;
    END IF;

    -- Only this migration's own rows. A row the application wrote survives.
    DELETE FROM loan_reclass_postings
     WHERE company_id = target_company AND source = 'backfill';

    INSERT INTO loan_reclass_postings
      (company_id, loan_id, yyyymm, st_liability, journal_entry_id, source)
    SELECT target_company, r.loan_id, r.yyyymm, r.st_liability, r.journal_entry_id, 'backfill'
      FROM tmp_k081_recon r
     WHERE r.loan_id NOT IN (SELECT loan_id FROM tmp_k081_tainted)
    ON CONFLICT (company_id, loan_id, yyyymm) DO NOTHING;

    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    total_rows := total_rows + inserted_rows;
  END LOOP;

  DROP TABLE tmp_k081_journals;
  DROP TABLE tmp_k081_tainted;
  DROP TABLE tmp_k081_recon;

  RAISE NOTICE 'loan_reclass_postings rebuilt: % row(s) reconstructed from posted reclass journals', total_rows;
  RAISE NOTICE 'refusals recorded: SELECT * FROM loan_reclass_backfill_refusals ORDER BY company_id, yyyymm;';
END $$;
