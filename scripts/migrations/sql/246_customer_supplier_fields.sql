-- 246: Customer & Supplier form fields — Sage parity
-- Adds missing fields to customers and suppliers tables

-- ── Customer fields ──────────────────────────────────────────────────────────

ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sales_rep_id UUID;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS mobile VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS fax VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS web_address VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cash_sale BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(15,2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opening_balance_date DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS accepts_electronic_invoices BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS auto_allocate_receipts BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS statement_distribution VARCHAR(20) DEFAULT 'email'; -- email, print, none
ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_discount NUMERIC(5,2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_price_list VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_vat_type VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms_type VARCHAR(30) DEFAULT 'days'; -- days, end_of_month
ALTER TABLE customers ADD COLUMN IF NOT EXISTS subject_to_drc_vat BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS invoices_viewable_online BOOLEAN DEFAULT true;

-- Delivery addresses (multiple per customer)
CREATE TABLE IF NOT EXISTS customer_delivery_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label VARCHAR(100) DEFAULT 'Delivery Address',
  address_line1 TEXT,
  address_line2 TEXT,
  address_line3 TEXT,
  address_line4 TEXT,
  postal_code VARCHAR(20),
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sales Reps table
CREATE TABLE IF NOT EXISTS sales_reps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Supplier fields ──────────────────────────────────────────────────────────

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS mobile VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS fax VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS web_address VARCHAR(255);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(15,2) DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS opening_balance_date DATE;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS auto_allocate_payments BOOLEAN DEFAULT false;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_discount NUMERIC(5,2) DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_vat_type VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms_type VARCHAR(30) DEFAULT 'days';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS subject_to_drc_vat BOOLEAN DEFAULT false;
-- Supplier banking details
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(50);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_branch_code VARCHAR(20);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account_type VARCHAR(30) DEFAULT 'current';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account_holder VARCHAR(255);
-- Physical address (separate from postal/billing)
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS physical_address TEXT;
