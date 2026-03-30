-- =============================================================================
-- Migration 275: Data Archiving & Retention Engine
-- WS-7.4: Archive old financial data to maintain DB performance.
-- SA Companies Act: minimum 5-year retention period enforced in application.
-- =============================================================================

-- Archive table for GL Journal Entries
-- Mirrors gl_journal_entries (company_id added via 220_multi_company_scoping)
CREATE TABLE IF NOT EXISTS archive_gl_journal_entries (
  id UUID PRIMARY KEY,
  entry_number VARCHAR(20),
  entry_date DATE NOT NULL,
  fiscal_period_id UUID,
  description TEXT,
  source VARCHAR(30),
  source_document_id UUID,
  status VARCHAR(20),
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  reversed_by UUID,
  reversed_at TIMESTAMPTZ,
  reversal_of_id UUID,
  created_by UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  reference VARCHAR(255),
  project_id UUID,
  cost_center_id UUID,
  company_id UUID REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_arch_je_company ON archive_gl_journal_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_arch_je_date ON archive_gl_journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_arch_je_company_date ON archive_gl_journal_entries(company_id, entry_date);

-- Archive table for GL Journal Lines
-- Mirrors gl_journal_lines (no company_id — scoped via journal entry join)
CREATE TABLE IF NOT EXISTS archive_gl_journal_lines (
  id UUID PRIMARY KEY,
  journal_entry_id UUID NOT NULL,
  gl_account_id UUID,
  debit NUMERIC(15,2) DEFAULT 0,
  credit NUMERIC(15,2) DEFAULT 0,
  description TEXT,
  project_id UUID,
  cost_center_id UUID,
  created_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_arch_jl_entry ON archive_gl_journal_lines(journal_entry_id);

-- Archive table for Bank Transactions
CREATE TABLE IF NOT EXISTS archive_bank_transactions (
  id UUID PRIMARY KEY,
  bank_account_id UUID,
  transaction_date DATE NOT NULL,
  value_date DATE,
  amount NUMERIC(15,2),
  description TEXT,
  reference VARCHAR(255),
  bank_reference VARCHAR(255),
  status VARCHAR(20),
  matched_journal_line_id UUID,
  reconciliation_id UUID,
  import_batch_id UUID,
  excluded_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  company_id UUID REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_arch_bt_company ON archive_bank_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_arch_bt_date ON archive_bank_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_arch_bt_company_date ON archive_bank_transactions(company_id, transaction_date);

-- Archive table for Customer Invoices
CREATE TABLE IF NOT EXISTS archive_customer_invoices (
  id UUID PRIMARY KEY,
  invoice_number VARCHAR(50),
  customer_id UUID,
  client_id UUID,
  billing_period_start DATE,
  billing_period_end DATE,
  subtotal NUMERIC(15,2),
  tax_rate NUMERIC(5,2),
  tax_amount NUMERIC(15,2),
  total_amount NUMERIC(15,2),
  amount_paid NUMERIC(15,2),
  status VARCHAR(30),
  invoice_date DATE,
  due_date DATE,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  notes TEXT,
  internal_notes TEXT,
  project_id UUID,
  gl_journal_entry_id UUID,
  created_by VARCHAR(255),
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  currency VARCHAR(3),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  company_id UUID REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_arch_ci_company ON archive_customer_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_arch_ci_date ON archive_customer_invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_arch_ci_company_date ON archive_customer_invoices(company_id, invoice_date);

-- Archive table for Supplier Invoices
CREATE TABLE IF NOT EXISTS archive_supplier_invoices (
  id UUID PRIMARY KEY,
  invoice_number VARCHAR(50),
  supplier_id UUID,
  purchase_order_id UUID,
  grn_id UUID,
  invoice_date DATE NOT NULL,
  due_date DATE,
  received_date DATE,
  subtotal NUMERIC(15,2),
  tax_rate NUMERIC(5,2),
  tax_amount NUMERIC(15,2),
  total_amount NUMERIC(15,2),
  amount_paid NUMERIC(15,2),
  payment_terms VARCHAR(50),
  currency VARCHAR(3),
  reference VARCHAR(255),
  status VARCHAR(30),
  match_status VARCHAR(30),
  project_id UUID,
  cost_center_id UUID,
  gl_journal_entry_id UUID,
  sage_invoice_id VARCHAR(100),
  notes TEXT,
  created_by VARCHAR(255),
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  company_id UUID REFERENCES companies(id)
);

CREATE INDEX IF NOT EXISTS idx_arch_si_company ON archive_supplier_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_arch_si_date ON archive_supplier_invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_arch_si_company_date ON archive_supplier_invoices(company_id, invoice_date);

-- Archive run tracking table
CREATE TABLE IF NOT EXISTS archive_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  run_by VARCHAR(255) NOT NULL REFERENCES users(id),
  cutoff_date DATE NOT NULL,
  entries_archived INT DEFAULT 0,
  lines_archived INT DEFAULT 0,
  transactions_archived INT DEFAULT 0,
  invoices_archived INT DEFAULT 0,
  supplier_invoices_archived INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archive_runs_company ON archive_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_archive_runs_status ON archive_runs(company_id, status);
