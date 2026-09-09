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

-- ── Backfill from the reclass journals that were actually posted ────────────
--
-- Without this, the first close after deploy would read no prior, post the
-- full current portion again on top of the balance the old code compounded,
-- and make the overstatement worse.
--
-- closeLoanPeriod builds its narrative deterministically as
--   'Reclassification – loan ' || COALESCE(reference, id::text) || ' for ' || yyyymm
-- (en dash), and puts it on both the entry description and every line. That
-- makes an exact equality join, not a LIKE guess. The balance after each close
-- is the running sum of the net CREDIT posted to that loan's current-portion
-- account, so this reconstructs the real history including the compounding —
-- which means the first close after deploy posts one correcting movement that
-- brings the account back to the right figure.
--
-- A loan whose reference was renamed after a close will not match; it gets no
-- backfill row for that month, and its next close reclassifies from the last
-- month that did match. Detection SQL for that case is in
-- docs/audits/remediation/K-081/fix.md.
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
      ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
    JOIN loans l
      ON l.company_id = je.company_id
     AND l.current_portion_account_id = jl.gl_account_id
     AND je.description = 'Reclassification – loan '
                       || COALESCE(l.reference, l.id::text)
                       || ' for ' || RIGHT(je.description, 6)
   WHERE je.status = 'posted'
     AND je.description LIKE 'Reclassification – loan % for %'
     AND RIGHT(je.description, 6) ~ '^[0-9]{6}$'
   GROUP BY je.company_id, l.id, RIGHT(je.description, 6), je.id
) reclass_history
ON CONFLICT (company_id, loan_id, yyyymm) DO NOTHING;
