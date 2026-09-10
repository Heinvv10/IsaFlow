-- Migration 621: audit trail for reversed payroll loan payments (K-022)
--
-- Recalculating a payroll run now undoes the loan instalments it applied
-- before re-applying them, so payroll_loan_payments rows are deleted on the
-- way through. That table is the only record an instalment was ever taken,
-- and its UNIQUE (loan_id, period_year, period_month) leaves no room for a
-- compensating row, so the deletion is recorded here instead.
--
-- payroll_audit_log (migration 344) would have been the natural home but was
-- dropped by migration 384, and audit_log requires a user_id that the
-- recalculation path does not have.

CREATE TABLE IF NOT EXISTS payroll_loan_payment_reversals (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  loan_id            UUID        NOT NULL REFERENCES payroll_loans(id) ON DELETE CASCADE,
  run_id             UUID        REFERENCES payroll_run_headers(id) ON DELETE SET NULL,
  period_year        INTEGER     NOT NULL,
  period_month       INTEGER     NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  principal_reversed NUMERIC(14,2) NOT NULL,
  interest_reversed  NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- false means the loan was no longer active when the run was recalculated,
  -- so the instalment was undone and never taken again.
  reapplied          BOOLEAN     NOT NULL DEFAULT false,
  reversed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_loan_payment_reversals_loan
  ON payroll_loan_payment_reversals(loan_id, period_year, period_month);

CREATE INDEX IF NOT EXISTS idx_payroll_loan_payment_reversals_run
  ON payroll_loan_payment_reversals(run_id);

COMMENT ON TABLE payroll_loan_payment_reversals IS
  'Tombstones for payroll_loan_payments rows deleted when a payroll run was recalculated. reapplied = false means the instalment was undone and not taken again.';

ALTER TABLE payroll_loan_payment_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_loan_payment_reversals FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='payroll_loan_payment_reversals' AND policyname='tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON payroll_loan_payment_reversals TO app_user
      USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_loan_payment_reversals TO app_user, platform_admin;
GRANT ALL ON payroll_loan_payment_reversals TO migration_admin;
