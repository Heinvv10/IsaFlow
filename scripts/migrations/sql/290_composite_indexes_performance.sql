-- Migration 290: Composite indexes for high-traffic query patterns
-- Addresses: WHERE company_id = ? AND status = ? ORDER BY created_at DESC
-- These cover the most common list/filter queries across accounting APIs.

-- Customer invoices: list, dashboard stats, dunning, aging
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ci_company_status_created
  ON customer_invoices(company_id, status, created_at DESC);

-- Supplier invoices: list, dashboard stats, aging, allocations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_si_company_status_created
  ON supplier_invoices(company_id, status, created_at DESC);

-- Bank transactions: list, reconciliation, matching
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bt_company_status_created
  ON bank_transactions(company_id, status, created_at DESC);

-- GL journal entries: trial balance, reports, posting
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gl_je_company_status_date
  ON gl_journal_entries(company_id, status, entry_date DESC);

-- Projects: list, profitability
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_company_status_created
  ON projects(company_id, status, created_at DESC);

-- Purchase orders: list, goods received
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_company_status_created
  ON purchase_orders(company_id, status, created_at DESC);

-- Assets: register, depreciation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assets_company_status_created
  ON assets(company_id, status, created_at DESC);

-- Stock adjustments: list view
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_adj_company_created
  ON stock_adjustments(company_id, created_at DESC);
