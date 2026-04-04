-- Migration 288: Add company_id to Sage staging tables for multi-tenant isolation
-- Audit item #28 — sage staging tables were globally shared across all tenants

-- ── sage_accounts ───────────────────────────────────────────────────────────
ALTER TABLE sage_accounts ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS idx_sage_accounts_company ON sage_accounts(company_id);

-- ── sage_ledger_transactions ────────────────────────────────────────────────
ALTER TABLE sage_ledger_transactions ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS idx_sage_ledger_company ON sage_ledger_transactions(company_id);

-- ── sage_supplier_invoices ──────────────────────────────────────────────────
ALTER TABLE sage_supplier_invoices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS idx_sage_supplier_inv_company ON sage_supplier_invoices(company_id);

-- ── sage_customer_invoices ──────────────────────────────────────────────────
ALTER TABLE sage_customer_invoices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS idx_sage_customer_inv_company ON sage_customer_invoices(company_id);

-- ── gl_migration_runs ───────────────────────────────────────────────────────
ALTER TABLE gl_migration_runs ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS idx_migration_runs_company ON gl_migration_runs(company_id);

-- ── gl_migration_comparisons ────────────────────────────────────────────────
ALTER TABLE gl_migration_comparisons ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS idx_migration_comparisons_company ON gl_migration_comparisons(company_id);
