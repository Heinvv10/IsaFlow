-- 247: Sales Orders & Purchase Orders
-- Mirrors the customer_invoices/supplier_invoices pattern

-- ── Customer Sales Orders ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  order_number VARCHAR(50) NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  quote_id UUID,
  order_date DATE DEFAULT CURRENT_DATE,
  delivery_date DATE,
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(30) DEFAULT 'draft' CHECK (status IN (
    'draft', 'confirmed', 'partially_invoiced', 'invoiced', 'cancelled'
  )),
  reference VARCHAR(255),
  notes TEXT,
  internal_notes TEXT,
  project_id UUID,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, order_number)
);

CREATE TABLE IF NOT EXISTS customer_sales_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id UUID NOT NULL REFERENCES customer_sales_orders(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(5,2) DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  line_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  item_id UUID,
  gl_account_id UUID,
  qty_invoiced NUMERIC(12,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cso_company ON customer_sales_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_cso_customer ON customer_sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_cso_status ON customer_sales_orders(status);

-- ── Supplier Purchase Orders ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  order_number VARCHAR(50) NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  order_date DATE DEFAULT CURRENT_DATE,
  delivery_date DATE,
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(30) DEFAULT 'draft' CHECK (status IN (
    'draft', 'sent', 'partially_received', 'received', 'partially_invoiced', 'invoiced', 'cancelled'
  )),
  reference VARCHAR(255),
  notes TEXT,
  internal_notes TEXT,
  project_id UUID,
  cost_center_id UUID,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, order_number)
);

CREATE TABLE IF NOT EXISTS supplier_purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES supplier_purchase_orders(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(5,2) DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  line_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  item_id UUID,
  gl_account_id UUID,
  qty_received NUMERIC(12,4) DEFAULT 0,
  qty_invoiced NUMERIC(12,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spo_company ON supplier_purchase_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_spo_supplier ON supplier_purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_spo_status ON supplier_purchase_orders(status);

-- ── Items table (if not exists) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  item_type VARCHAR(20) DEFAULT 'physical' CHECK (item_type IN ('physical', 'service')),
  category_id UUID,
  is_active BOOLEAN DEFAULT true,
  unit VARCHAR(50),
  cost_price NUMERIC(15,2) DEFAULT 0,
  selling_price_excl NUMERIC(15,2) DEFAULT 0,
  selling_price_incl NUMERIC(15,2) DEFAULT 0,
  gp_percent NUMERIC(5,2) DEFAULT 0,
  vat_on_sales VARCHAR(50) DEFAULT 'standard',
  vat_on_purchases VARCHAR(50) DEFAULT 'standard',
  sales_account_id UUID,
  purchases_account_id UUID,
  opening_qty NUMERIC(12,4) DEFAULT 0,
  opening_cost NUMERIC(15,2) DEFAULT 0,
  opening_date DATE,
  current_qty NUMERIC(12,4) DEFAULT 0,
  notes TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_items_company ON items(company_id);
CREATE INDEX IF NOT EXISTS idx_items_code ON items(code);
CREATE INDEX IF NOT EXISTS idx_items_active ON items(is_active);

-- Item categories
CREATE TABLE IF NOT EXISTS item_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, name)
);
