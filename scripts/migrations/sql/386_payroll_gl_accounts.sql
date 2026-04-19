-- 386_payroll_gl_accounts.sql
-- PRD-02 Phase 3: per-company mapping of payroll roles → GL accounts.
-- 7 rows per company once configured. The role key is a plain TEXT enum
-- (using a CHECK constraint rather than a PG enum to keep schema changes
-- cheap if new roles are added later).

CREATE TABLE IF NOT EXISTS payroll_gl_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN (
    'salaries_expense',
    'net_salaries_payable',
    'paye_payable',
    'uif_payable',
    'sdl_payable',
    'uif_employer_expense',
    'sdl_employer_expense'
  )),
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, role)
);

CREATE INDEX IF NOT EXISTS idx_payroll_gl_accounts_company
  ON payroll_gl_accounts (company_id);
