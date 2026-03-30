-- Migration 255: Fix missing schema — tables and columns required by API routes
-- Created: 2026-03-30

-- 1. Add category column to suppliers
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS category VARCHAR(100);

-- 2. Create stock_items table
--    Column names match what item-adjustments.ts, item-pricing.ts, item-opening-balances.ts query:
--    name, uom, category, qty_available, standard_cost, list_price
CREATE TABLE IF NOT EXISTS stock_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL,
  item_code        VARCHAR(50),
  name             VARCHAR(255),
  uom              VARCHAR(20) DEFAULT 'each',
  category         VARCHAR(100),
  standard_cost    NUMERIC(15,2) DEFAULT 0,
  list_price       NUMERIC(15,2) DEFAULT 0,
  qty_available    NUMERIC(15,4) DEFAULT 0,
  reorder_level    NUMERIC(15,4) DEFAULT 0,
  tax_rate         NUMERIC(5,2) DEFAULT 15,
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create exchange_rates table
CREATE TABLE IF NOT EXISTS exchange_rates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL,
  from_currency    VARCHAR(3) NOT NULL,
  to_currency      VARCHAR(3) NOT NULL,
  rate             NUMERIC(15,6) NOT NULL,
  effective_date   DATE NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create accounting_settings table
CREATE TABLE IF NOT EXISTS accounting_settings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL,
  key              VARCHAR(100) NOT NULL,
  value            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, key)
);

-- 5. Add is_drc column to supplier_invoices
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS is_drc BOOLEAN DEFAULT FALSE;

-- 6. Add updated_at column to item_categories
ALTER TABLE item_categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_stock_items_company ON stock_items(company_id);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_company ON exchange_rates(company_id);
CREATE INDEX IF NOT EXISTS idx_accounting_settings_company_key ON accounting_settings(company_id, key);
