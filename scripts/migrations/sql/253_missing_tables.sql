-- 253: Missing tables referenced in code but not yet created
-- Addresses autoresearch findings: 11 missing tables + 6 missing columns

-- ── Customer Quotes ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  quote_number TEXT NOT NULL,
  client_id UUID REFERENCES customers(id),
  customer_name TEXT,
  quote_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','expired','converted')),
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  converted_invoice_id UUID REFERENCES customer_invoices(id),
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cq_company ON customer_quotes(company_id);
CREATE INDEX IF NOT EXISTS idx_cq_client ON customer_quotes(client_id);

CREATE TABLE IF NOT EXISTS customer_quote_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES customer_quotes(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(10,2) DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  gl_account_id UUID,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Exchange Rates ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  from_currency TEXT NOT NULL DEFAULT 'ZAR',
  to_currency TEXT NOT NULL,
  rate NUMERIC(15,6) NOT NULL,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_er_currencies ON exchange_rates(from_currency, to_currency, effective_date DESC);

-- ── Accounting Settings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounting_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  setting_key TEXT NOT NULL,
  setting_value TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, setting_key)
);

-- ── App Settings (global) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Dunning Communications ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dunning_communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  dunning_level INT NOT NULL DEFAULT 1,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  method TEXT DEFAULT 'email' CHECK (method IN ('email','sms','letter','phone')),
  subject TEXT,
  body TEXT,
  amount_outstanding NUMERIC(15,2),
  days_overdue INT,
  status TEXT DEFAULT 'sent' CHECK (status IN ('draft','sent','acknowledged','failed')),
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dc_customer ON dunning_communications(customer_id);

-- ── Bank Import Batches ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  bank_account_id UUID NOT NULL REFERENCES gl_accounts(id),
  statement_date DATE,
  bank_format TEXT,
  opening_balance NUMERIC(15,2),
  closing_balance NUMERIC(15,2),
  transaction_count INT DEFAULT 0,
  filename TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bib_bank ON bank_import_batches(bank_account_id);

-- ── Customer & Supplier Categories ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS supplier_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Supplier Payment Allocations (distinct from payment_allocations) ────────
CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES supplier_invoices(id),
  amount NUMERIC(15,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(payment_id, invoice_id)
);

-- ── Stock Items view (alias for products table used by item-* APIs) ─────────
-- Many API endpoints reference stock_items but the actual table is products
CREATE OR REPLACE VIEW stock_items AS
SELECT id, company_id, sku AS code, name, description,
       selling_price AS list_price, cost_price AS standard_cost,
       qty_on_hand AS qty_available, reorder_level AS min_level,
       is_active, 'physical' AS item_type,
       category_id, created_at, updated_at
FROM products;

-- ── Missing bank_transactions columns (smart categorization) ────────────────
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_gl_account_id UUID REFERENCES gl_accounts(id);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_supplier_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_client_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_vat_code TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_category TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS allocation_type TEXT;

-- ── Missing company_id on captured_documents ────────────────────────────────
ALTER TABLE captured_documents ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
