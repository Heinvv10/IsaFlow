-- Migration 211: Schema Patches for Standalone App
-- Columns and tables referenced by API routes but missing from base migrations

-- GL Accounts extras
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(50);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS default_vat_code VARCHAR(20);

-- Journal entries/lines extras
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS reference VARCHAR(255);
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS cost_center_id UUID;
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS cost_center_id UUID;
ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS project_id UUID;

-- Bank transactions extras
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS excluded_reason TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS notes TEXT;

-- Bank categorisation rules
CREATE TABLE IF NOT EXISTS bank_categorisation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name VARCHAR(255) NOT NULL,
  match_field VARCHAR(50) DEFAULT 'description',
  match_type VARCHAR(20) DEFAULT 'contains',
  match_value TEXT NOT NULL,
  gl_account_id UUID REFERENCES gl_accounts(id),
  supplier_id UUID,
  client_id UUID,
  category VARCHAR(100),
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  apply_vat BOOLEAN DEFAULT false,
  priority INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  auto_approve BOOLEAN DEFAULT false,
  notes TEXT,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Currencies
CREATE TABLE IF NOT EXISTS currencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(3) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  symbol VARCHAR(5),
  exchange_rate NUMERIC(15,6) DEFAULT 1.000000,
  is_base BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO currencies (code, name, symbol, is_base, is_active)
VALUES ('ZAR', 'South African Rand', 'R', true, true)
ON CONFLICT (code) DO NOTHING;

-- Cost Centres
CREATE TABLE IF NOT EXISTS cost_centres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Budgets
CREATE TABLE IF NOT EXISTS accounting_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_name VARCHAR(255) NOT NULL,
  fiscal_year INTEGER NOT NULL,
  gl_account_id UUID REFERENCES gl_accounts(id),
  period_amounts JSONB DEFAULT '{}',
  total_amount NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',
  notes TEXT,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Suppliers extras
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS company_name VARCHAR(255);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS category VARCHAR(100);

-- Customer invoices extras
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'ZAR';

-- Credit notes extras
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'ZAR';
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS cost_center_id UUID;

-- Supplier invoices extras
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS cost_center_id UUID;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS approved_by VARCHAR(255);
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS gl_journal_entry_id UUID;

-- Supplier payments extras
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cost_center_id UUID;

-- Customer payments extras
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS cost_center_id UUID;

-- Clients view (backward compatibility for code that references 'clients' table)
DROP VIEW IF EXISTS clients CASCADE;
CREATE VIEW clients AS
SELECT id, name as company_name, name, email, phone, vat_number,
       contact_person, payment_terms, credit_limit,
       is_active, notes, created_at, updated_at
FROM customers;
