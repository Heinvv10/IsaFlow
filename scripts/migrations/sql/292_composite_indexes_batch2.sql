-- Migration 292: Composite indexes batch 2 — remaining high-traffic list queries
-- Covers tables missed in migration 290 that use WHERE company_id = ? ORDER BY created_at DESC

-- VAT adjustments
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vat_adj_company_status_created
  ON vat_adjustments(company_id, status, created_at DESC);

-- Customer quotes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quotes_company_status_created
  ON customer_quotes(company_id, status, created_at DESC);

-- Recurring invoices
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_recurring_inv_company_status_created
  ON recurring_invoices(company_id, status, created_at DESC);

-- Credit notes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_notes_company_status_created
  ON credit_notes(company_id, status, created_at DESC);

-- Customer payments
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cp_company_status_created
  ON customer_payments(company_id, status, created_at DESC);

-- Supplier payments
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sp_company_status_created
  ON supplier_payments(company_id, status, created_at DESC);

-- Customer write-offs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wo_company_status_created
  ON customer_write_offs(company_id, status, created_at DESC);

-- Accounting adjustments
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_adj_company_status_created
  ON accounting_adjustments(company_id, status, created_at DESC);

-- Recurring journals
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rj_company_status_created
  ON recurring_journals(company_id, status, created_at DESC);
