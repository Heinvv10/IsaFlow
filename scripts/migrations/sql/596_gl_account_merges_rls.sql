-- Migration 596: tenant isolation on gl_account_merges.
--
-- Migration 595 created the table and stopped at its indexes. It was the ONLY
-- table in the schema carrying a `company_id` and no row-level security —
-- verified against isaflow_dev with the coverage query from
-- tests/integration/rls-policy-coverage.test.ts, which returned exactly one row.
-- Every other company_id table passes.
--
-- That is the wrong table to leave open. It records which journal lines of which
-- tenant's ledger were moved, by whom, and under which token — the row a client
-- auditor would read to establish what an agent did to their books.
--
-- Split from 595 rather than added to it because 595 is already applied and its
-- checksum recorded; editing an applied migration produces a checksum conflict
-- that cannot be resolved by editing it back.
--
-- Two reasons this escaped the gate, both worth knowing before trusting a green
-- CI run on the next table: `rls-policy-coverage.test.ts` lives in the
-- INTEGRATION suite, which `bun run ci` skips silently without DATABASE_URL and
-- five other variables — so the check that would have caught it did not run.
--
-- Shape copied verbatim from 570_vat_period_locks.sql. The DO block makes the
-- policy idempotent; `CREATE POLICY` has no IF NOT EXISTS.

ALTER TABLE gl_account_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_account_merges FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'gl_account_merges' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON gl_account_merges
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id());
  END IF;
END $$;
