-- 645_loan_reclass_postings.sql
--
-- K-081 (review H2 / M3). closeLoanPeriod reclassifies a loan's current portion
-- by journalling the MOVEMENT since the previous close, so it has to know what
-- the previous close actually put there. It used to re-derive that from the
-- schedule, keyed off loan_period_locks, and both halves of that are wrong:
--
--   H2  a lock is written unconditionally, including for loans the close
--       skipped (missing GL accounts, no schedule row, zero movement). The
--       next close then read a "prior" for a reclass that never posted and
--       drove the current-portion account into a debit balance.
--   M3  the lateral read the LATEST schedule run, so any reprice or loan edit
--       between two closes silently moved the earlier figure, and the
--       difference stuck in the current-portion account permanently.
--
-- This table records what was posted, per loan per period, at the moment it is
-- posted. No row means no reclass happened for that loan in that month, which
-- is exactly the H2 distinction the lock could not make.
--
-- LOCKING (review L3): CREATE TABLE takes no lock on existing tables. The
-- backfill below reads gl_journal_entries / gl_journal_lines and writes only to
-- this new table. Safe to run online.

CREATE TABLE IF NOT EXISTS loan_reclass_postings (
  company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  loan_id          UUID        NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  yyyymm           CHAR(6)     NOT NULL,
  -- The current-portion balance this loan's current-portion account holds for
  -- this loan AFTER the close, i.e. the schedule row's st_liability that was
  -- reclassified to. The next close journals target - this.
  st_liability     NUMERIC(18,2) NOT NULL,
  journal_entry_id UUID        REFERENCES gl_journal_entries(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, loan_id, yyyymm)
);

CREATE INDEX IF NOT EXISTS idx_loan_reclass_postings_loan_period
  ON loan_reclass_postings(company_id, loan_id, yyyymm DESC);

ALTER TABLE loan_reclass_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_reclass_postings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON loan_reclass_postings;
CREATE POLICY tenant_isolation ON loan_reclass_postings
  FOR ALL
  TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON loan_reclass_postings TO app_user;

-- ── Backfill from the reclass journals that were actually posted ───────────
--
-- Without this, the first close after deploy would read no prior, post the
-- full current portion again on top of the balance the old code compounded,
-- and make the overstatement worse. With it, that close posts one correcting
-- movement instead.
--
-- closeLoanPeriod builds its narrative deterministically as
--   'Reclassification – loan ' || COALESCE(reference, id::text) || ' for ' || yyyymm
-- (en dash), on the entry description and every line. That is an exact equality
-- join, not a LIKE guess. The balance after each close is the running sum of the
-- net CREDIT posted to that loan's current-portion account, so this reconstructs
-- the real history including the compounding.
--
-- SCOPING: the INSERT runs once per company, with company_id bound as a
-- parameter and repeated on every join, so no statement can read or write
-- across tenants even if a gl_account_id or loan_id were reused.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING, so re-running changes nothing and rows
-- written by the running application always win over a reconstructed figure.
-- Safe to re-run after a partial failure.
--
-- SUPERSEDED: this reconstruction identifies a loan by REBUILDING ITS
-- NARRATIVE STRING, and neither half of that key is unique. Migration 659
-- deletes every row written here and rebuilds them by resolving the key out of
-- the narrative instead. Do not read the paragraph above as current behaviour;
-- 659's header is.
DO $$
DECLARE
  target_company UUID;
  inserted_rows  BIGINT;
  total_rows     BIGINT := 0;
BEGIN
  -- Round-5 M2. A database that has run 659 but lost its schema_migrations
  -- rows (a fixture restored from a dump, a hand-rolled clone) re-runs this
  -- file. 659 leaves `loan_reclass_postings.source` DEFAULTing to 'app', so
  -- the defective rows below would come back stamped as though the running
  -- application had written them — and 659 only ever deletes its own
  -- ('backfill') rows, so nothing would clear them again. The presence of the
  -- column is the fact that matters, not the tracking row: skip.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'loan_reclass_postings' AND column_name = 'source'
  ) THEN
    RAISE NOTICE 'loan_reclass_postings backfill skipped: migration 659 has already rebuilt this table';
    RETURN;
  END IF;

  FOR target_company IN
    SELECT DISTINCT company_id FROM loans
  LOOP
    INSERT INTO loan_reclass_postings (company_id, loan_id, yyyymm, st_liability, journal_entry_id)
    SELECT company_id, loan_id, yyyymm, running_balance, journal_entry_id
    FROM (
      SELECT je.company_id,
             l.id AS loan_id,
             RIGHT(je.description, 6) AS yyyymm,
             je.id AS journal_entry_id,
             SUM(SUM(jl.credit - jl.debit)) OVER (
               PARTITION BY je.company_id, l.id
               ORDER BY RIGHT(je.description, 6)
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS running_balance
        FROM gl_journal_entries je
        JOIN gl_journal_lines jl
          ON jl.journal_entry_id = je.id
         AND jl.company_id = je.company_id
         AND jl.company_id = target_company
        JOIN loans l
          ON l.company_id = je.company_id
         AND l.company_id = target_company
         AND l.current_portion_account_id = jl.gl_account_id
         AND je.description = 'Reclassification – loan '
                           || COALESCE(l.reference, l.id::text)
                           || ' for ' || RIGHT(je.description, 6)
       WHERE je.company_id = target_company
         AND je.status = 'posted'
         AND je.description LIKE 'Reclassification – loan % for %'
         AND RIGHT(je.description, 6) ~ '^[0-9]{6}$'
       GROUP BY je.company_id, l.id, RIGHT(je.description, 6), je.id
    ) reclass_history
    ON CONFLICT (company_id, loan_id, yyyymm) DO NOTHING;

    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    total_rows := total_rows + inserted_rows;
  END LOOP;

  RAISE NOTICE 'loan_reclass_postings backfill: % row(s) reconstructed from posted reclass journals', total_rows;
END $$;
