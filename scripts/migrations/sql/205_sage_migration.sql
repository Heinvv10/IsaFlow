-- Migration 205: Sage Migration Infrastructure (Standalone)
-- Account mapping, migration tracking, Sage data import tables

-- ── Sage Account Cache (imported from Sage) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS sage_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sage_id VARCHAR(100),
  account_code VARCHAR(50),
  account_name VARCHAR(255),
  account_type VARCHAR(50),
  category VARCHAR(100),
  balance NUMERIC(15,2) DEFAULT 0,
  gl_account_id UUID REFERENCES gl_accounts(id),
  mapping_status VARCHAR(20) DEFAULT 'unmapped',
  mapping_notes TEXT,
  imported_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sage_accounts_code ON sage_accounts(account_code);
CREATE INDEX IF NOT EXISTS idx_sage_accounts_mapping ON sage_accounts(mapping_status);

-- ── Sage Ledger Transactions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sage_ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sage_id VARCHAR(100),
  account_code VARCHAR(50),
  transaction_date DATE,
  description TEXT,
  debit NUMERIC(15,2) DEFAULT 0,
  credit NUMERIC(15,2) DEFAULT 0,
  reference VARCHAR(255),
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  migration_status VARCHAR(20) DEFAULT 'pending',
  imported_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sage_ledger_date ON sage_ledger_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_sage_ledger_status ON sage_ledger_transactions(migration_status);

-- ── Sage Supplier Invoices ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sage_supplier_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sage_id VARCHAR(100),
  invoice_number VARCHAR(50),
  supplier_name VARCHAR(255),
  invoice_date DATE,
  total_amount NUMERIC(15,2) DEFAULT 0,
  gl_supplier_invoice_id UUID REFERENCES supplier_invoices(id),
  migration_status VARCHAR(20) DEFAULT 'pending',
  imported_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── Sage Customer Invoices ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sage_customer_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sage_id VARCHAR(100),
  invoice_number VARCHAR(50),
  customer_name VARCHAR(255),
  invoice_date DATE,
  total_amount NUMERIC(15,2) DEFAULT 0,
  migration_status VARCHAR(20) DEFAULT 'pending',
  imported_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── Migration Runs Tracking ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_migration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  total_records INTEGER DEFAULT 0,
  processed INTEGER DEFAULT 0,
  succeeded INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  details JSONB DEFAULT '{}',
  error_message TEXT,
  started_by VARCHAR(255),
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_migration_runs_type ON gl_migration_runs(run_type);
CREATE INDEX IF NOT EXISTS idx_migration_runs_status ON gl_migration_runs(status);

-- ── Migration comparison snapshots ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_migration_comparisons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_date DATE NOT NULL DEFAULT CURRENT_DATE,
  sage_totals JSONB NOT NULL DEFAULT '{}',
  gl_totals JSONB NOT NULL DEFAULT '{}',
  differences JSONB NOT NULL DEFAULT '{}',
  is_balanced BOOLEAN DEFAULT false,
  notes TEXT,
  created_by VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
