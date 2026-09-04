/**
 * Mutation counterexamples for migrationRlsRule — proof it fires on what it
 * must, and stays quiet on what it must not, per CONTRACTS.md's evidence
 * rule. The gate exists because `595_gl_account_merges.sql` shipped a
 * `company_id` table with no RLS anywhere, and the guard that would have
 * caught it (an integration test gated on DATABASE_URL) silently skipped
 * instead of failing.
 */
import { describe, it, expect } from 'vitest';
import { findViolations, findCreateTables } from '../../../scripts/ci/migrationRlsRule';

/** 595_gl_account_merges.sql's actual shape, trimmed to what matters: a
 * company_id table, no ENABLE, no FORCE, no policy, anywhere in the file. */
const UNPROTECTED_TABLE = {
  file: 'scripts/migrations/sql/595_gl_account_merges.sql',
  text: `
CREATE TABLE IF NOT EXISTS gl_account_merges (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID NOT NULL REFERENCES companies(id),
  source_account_id         UUID NOT NULL REFERENCES gl_accounts(id),
  moved_line_ids            UUID[] NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gl_account_merges_company
  ON gl_account_merges (company_id, created_at DESC);
`,
};

/** 570_vat_period_locks.sql's actual shape: CREATE TABLE, ENABLE, FORCE, and
 * a policy guarded by IF NOT EXISTS, all in the same file. */
const PROTECTED_TABLE = {
  file: 'scripts/migrations/sql/570_vat_period_locks.sql',
  text: `
CREATE TABLE IF NOT EXISTS vat_period_locks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  period_start      DATE NOT NULL,
  locked_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
`,
};

describe('migrationRlsRule', () => {
  it('FAILS on 595_gl_account_merges.sql as written today — no RLS anywhere', () => {
    const v = findViolations([UNPROTECTED_TABLE]);
    expect(v.map(x => x.table)).toEqual(['gl_account_merges']);
  });

  it('PASSES on 570_vat_period_locks.sql', () => {
    expect(findViolations([PROTECTED_TABLE])).toEqual([]);
  });

  it('FAILS on a synthetic migration creating two company_id tables and protecting only one', () => {
    const file = {
      file: 'scripts/migrations/sql/999_two_tables.sql',
      text: `
CREATE TABLE IF NOT EXISTS protected_thing (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id)
);
ALTER TABLE protected_thing ENABLE ROW LEVEL SECURITY;
ALTER TABLE protected_thing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON protected_thing
  USING (company_id = app.current_company_id());

CREATE TABLE IF NOT EXISTS unprotected_thing (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id)
);
`,
    };
    const v = findViolations([file]);
    expect(v.map(x => x.table)).toEqual(['unprotected_thing']);
  });

  it('PASSES on a table with no company_id column and no RLS — the common, legitimate case', () => {
    const file = {
      file: 'scripts/migrations/sql/999_no_tenant_column.sql',
      text: `
CREATE TABLE IF NOT EXISTS system_config (
  id UUID PRIMARY KEY,
  config_key TEXT NOT NULL,
  config_value TEXT
);
`,
    };
    expect(findViolations([file])).toEqual([]);
  });

  it('PASSES when RLS arrives in a LATER, separate migration file (whole-directory, not same-file)', () => {
    // The repo's own established pattern: 467_personal_access_tokens.sql
    // creates the table, 468_personal_access_tokens_rls.sql protects it two
    // migrations later. A same-file rule would fail this pair forever.
    const created = {
      file: 'scripts/migrations/sql/467_personal_access_tokens.sql',
      text: `
CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id)
);
`,
    };
    const protectedLater = {
      file: 'scripts/migrations/sql/468_personal_access_tokens_rls.sql',
      text: `
ALTER TABLE personal_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY pat_owner ON personal_access_tokens
  USING (company_id = app.current_company_id());
`,
    };
    expect(findViolations([created, protectedLater])).toEqual([]);
  });

  it('recognizes the 505_close_runs.sql dynamic FOREACH/ARRAY/EXECUTE-format shape as protected', () => {
    const file = {
      file: 'scripts/migrations/sql/505_close_runs.sql',
      text: `
CREATE TABLE IF NOT EXISTS close_runs (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id)
);
CREATE TABLE IF NOT EXISTS close_run_proposals (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['close_runs', 'close_run_proposals'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (true)', t);
  END LOOP;
END $$;
`,
    };
    expect(findViolations([file])).toEqual([]);
  });

  it('does NOT credit a table merely named in an ARRAY[] with no accompanying RLS grants', () => {
    // The narrow-recognition guard: the array alone proves nothing without
    // the three RLS incantations actually present in the same file.
    const file = {
      file: 'scripts/migrations/sql/999_array_no_rls.sql',
      text: `
CREATE TABLE IF NOT EXISTS some_table (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['some_table'] LOOP
    RAISE NOTICE 'checking %', t;
  END LOOP;
END $$;
`,
    };
    const v = findViolations([file]);
    expect(v.map(x => x.table)).toEqual(['some_table']);
  });

  it('attributes multiple CREATE TABLE statements in one file correctly (findCreateTables)', () => {
    const text = `
CREATE TABLE IF NOT EXISTS a (id UUID PRIMARY KEY, company_id UUID NOT NULL);
CREATE TABLE IF NOT EXISTS b (id UUID PRIMARY KEY);
`;
    const tables = findCreateTables('x.sql', text);
    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ table: 'a', hasCompanyId: true });
    expect(tables[1]).toMatchObject({ table: 'b', hasCompanyId: false });
  });

  it('does not desync paren-depth on a nested-parens column definition (NUMERIC(15,2), CHECK(...))', () => {
    const file = {
      file: 'scripts/migrations/sql/999_nested_parens.sql',
      text: `
CREATE TABLE IF NOT EXISTS with_nested_parens (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  amount NUMERIC(15,2) NOT NULL,
  CONSTRAINT range_ck CHECK (amount >= 0)
);
CREATE TABLE IF NOT EXISTS next_table (
  id UUID PRIMARY KEY
);
`,
    };
    const tables = findCreateTables(file.file, file.text);
    expect(tables.map(t => t.table)).toEqual(['with_nested_parens', 'next_table']);
    expect(tables[0]!.hasCompanyId).toBe(true);
  });

  it('does not desync paren-depth on a string literal containing a paren', () => {
    const file = {
      file: 'scripts/migrations/sql/999_paren_in_string.sql',
      text: `
CREATE TABLE IF NOT EXISTS weird_default (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  note TEXT DEFAULT 'see docs (section 3)'
);
CREATE TABLE IF NOT EXISTS after_it (
  id UUID PRIMARY KEY
);
`,
    };
    const tables = findCreateTables(file.file, file.text);
    expect(tables.map(t => t.table)).toEqual(['weird_default', 'after_it']);
  });
});
