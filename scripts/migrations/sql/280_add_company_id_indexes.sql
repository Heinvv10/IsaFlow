-- Migration 280: Add missing company_id indexes
-- Only indexes for tables that exist but were NOT covered by 220_multi_company_scoping.sql
-- or their own creation migration.
--
-- Already indexed in 220: gl_accounts, gl_journal_entries, customer_invoices,
--   supplier_invoices, customers, suppliers, bank_transactions, bank_reconciliations,
--   credit_notes, fiscal_periods, customer_payments, supplier_payments, stock_items,
--   recurring_invoices, recurring_journals, vat_adjustments, cost_centres,
--   exchange_rates, customer_quotes, customer_sales_orders, purchase_orders.
--
-- Already indexed in their own migration: approval_rules, approval_requests are
--   missing company_id entirely (234_approval_workflows.sql did not add it).
--   payroll_runs has idx_payroll_runs_company_id (added in 230).
--   stock_items has idx_stock_items_company (added in 255).
--
-- This migration adds indexes for tables confirmed to exist but not yet indexed:

-- approval_rules and approval_requests — company_id was not added in 234.
-- Add the column first (idempotent), then index it.
ALTER TABLE approval_rules    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

CREATE INDEX IF NOT EXISTS idx_approval_rules_company    ON approval_rules(company_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_company ON approval_requests(company_id);

-- journal_entries is not a standalone table in this schema (the table is
-- gl_journal_entries, already indexed). Skipped.

-- description_templates — this table name resolves to transaction_description_templates
-- in the codebase (see idx_desc_templates_company already created).
-- Skipped to avoid duplicate.

-- write_offs — the actual table is customer_write_offs, already indexed in 220.
-- Skipped.

-- adjustments — the actual table is accounting_adjustments, already indexed in 220.
-- Skipped.

-- batch_payments — the actual table is supplier_payment_batches, already indexed in 220.
-- Skipped.

-- fixed_assets — the actual table is assets (created in fixed_assets migration).
-- idx_assets_company already exists. Skipped.

-- budgets — the actual table is accounting_budgets, already indexed in 220.
-- Skipped.

-- payslips — company_id not present on this table yet (payroll scopes by
-- payroll_run which has company_id, but direct company_id is useful).
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- Backfill company_id on payslips from parent payroll_run
UPDATE payslips ps
SET company_id = pr.company_id
FROM payroll_runs pr
WHERE ps.payroll_run_id = pr.id
  AND ps.company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_payslips_company ON payslips(company_id);
