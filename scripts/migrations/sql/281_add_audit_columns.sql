-- Migration 281: Add missing audit columns to transaction tables
-- All statements use IF NOT EXISTS (PostgreSQL 9.6+).
-- Tables verified to exist before adding columns.

-- ── created_by ────────────────────────────────────────────────────────────────

-- bank_transactions: created in 203_bank_reconciliation.sql without created_by
ALTER TABLE bank_transactions     ADD COLUMN IF NOT EXISTS created_by UUID;

-- bank_reconciliations: created in 203_bank_reconciliation.sql without created_by
ALTER TABLE bank_reconciliations  ADD COLUMN IF NOT EXISTS created_by UUID;

-- payslips: created in 230_payroll.sql without created_by
ALTER TABLE payslips              ADD COLUMN IF NOT EXISTS created_by UUID;

-- ── updated_at ────────────────────────────────────────────────────────────────

-- customer_invoice_items: created in 000_users_and_auth.sql without updated_at
ALTER TABLE customer_invoice_items  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- supplier_invoice_items: created in 201_accounts_payable.sql without updated_at
ALTER TABLE supplier_invoice_items  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- gl_journal_lines: created in 200_accounting_foundation.sql without updated_at
ALTER TABLE gl_journal_lines        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- payroll_runs: created in 230_payroll.sql without updated_at
ALTER TABLE payroll_runs            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- payslips: created in 230_payroll.sql without updated_at
ALTER TABLE payslips                ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
