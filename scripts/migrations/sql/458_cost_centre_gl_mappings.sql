-- 458_cost_centre_gl_mappings.sql
-- Cost-centre → GL expense-account map. Closes the last VIP-parity gap:
-- payroll journals currently hit one 5200 Labour Costs account for the
-- whole run. With this table the posting service splits the labour debit
-- across per-centre accounts (ADMIN → 5100, PROJECTS → 5200, etc.) so
-- management-account profitability-by-centre is accurate without a
-- month-end reclass journal.
--
-- Only the labour expense side splits — PAYE / UIF / SDL / Bank credit
-- sides stay single lines because SARS is paid one cheque per company.

CREATE TABLE IF NOT EXISTS cost_centre_gl_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cost_centre_id UUID NOT NULL REFERENCES cost_centres(id) ON DELETE CASCADE,
  expense_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, cost_centre_id)
);

CREATE INDEX IF NOT EXISTS idx_cost_centre_gl_mappings_company
  ON cost_centre_gl_mappings(company_id);

COMMENT ON TABLE cost_centre_gl_mappings IS
  'Maps a cost centre to the GL expense account that should receive its share of payroll labour debits. Unmapped centres (and employees with no cost centre at all) fall back to the default 5200 Labour Costs account used by the single-line legacy posting path.';
