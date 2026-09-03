-- 570: VAT period locks.
--
-- A VAT201 is filed against a period and then the period must stop moving. Today
-- nothing stops a journal being posted into a filed period: Velocity Fibre's
-- ledger accepts a 2022 posting made today, and the return that was submitted
-- for 2022 no longer agrees with the ledger it was computed from. That is not a
-- reporting inconvenience — it is the difference between a return that can be
-- re-derived on request and one that cannot.
--
-- SEPARATE FROM fiscal_periods ON PURPOSE. SA VAT periods are two calendar
-- months and fiscal periods here are monthly on an arbitrary year end; the two
-- do not line up, and closing a fiscal period is a different decision from
-- filing a VAT return. `loan_period_locks` is the existing precedent for a
-- domain owning its own lock table.
--
-- The lock RECORDS the filing; it does not enforce it at the database level. A
-- trigger on gl_journal_lines would take the enforcement decision away from the
-- application for every existing write path at once, and several of them (bank
-- rule sweeps, the reversal paths) have no user-facing way to react to it. The
-- application refuses the post and the lock is what it reads.

CREATE TABLE IF NOT EXISTS vat_period_locks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  -- What the return said at the moment it was locked. A lock that does not
  -- record the figures cannot show that the ledger has drifted since.
  output_tax        NUMERIC(15,2) NOT NULL,
  input_tax         NUMERIC(15,2) NOT NULL,
  net_vat           NUMERIC(15,2) NOT NULL,
  -- MAX(created_at) of the journals the figures were computed from. Same
  -- period and same posted_through must give the same numbers, or something
  -- was back-dated into a filed period.
  posted_through    TIMESTAMPTZ NOT NULL,
  -- users.id is character varying(255), NOT uuid, so this is TEXT and carries
  -- no foreign key. A uuid-typed FK to it fails at apply time.
  locked_by         TEXT NOT NULL,
  -- 'human' | 'agent' | 'system'. An MCP write is always 'agent'.
  actor_type        TEXT NOT NULL DEFAULT 'agent',
  -- The MCP token that locked it, so a revoked token's locks can be listed.
  actor_token_jti   TEXT,
  locked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes             TEXT,
  CONSTRAINT vat_period_locks_range_ck CHECK (period_end >= period_start),
  CONSTRAINT vat_period_locks_actor_ck CHECK (actor_type IN ('human', 'agent', 'system'))
);

-- One lock per period per company. The tool is idempotent against this: a
-- second lock of the same period returns the existing one rather than failing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vat_period_locks_company_period
  ON vat_period_locks (company_id, period_start, period_end);

-- The lookup every posting path makes: "is the date I am about to post inside a
-- locked VAT period for this company?"
CREATE INDEX IF NOT EXISTS idx_vat_period_locks_company_range
  ON vat_period_locks (company_id, period_start, period_end);

ALTER TABLE vat_period_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE vat_period_locks FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'vat_period_locks' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON vat_period_locks
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id());
  END IF;
END $$;
