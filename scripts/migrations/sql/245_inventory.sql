-- Inventory & Products Module (Sprint 2)

-- ── Product Categories ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_id UUID REFERENCES product_categories(id),
  gl_inventory_account_id UUID REFERENCES gl_accounts(id),
  gl_cogs_account_id UUID REFERENCES gl_accounts(id),
  gl_revenue_account_id UUID REFERENCES gl_accounts(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Products / Items ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category_id UUID REFERENCES product_categories(id),
  category TEXT,
  barcode TEXT,
  unit TEXT NOT NULL DEFAULT 'each',
  product_type TEXT NOT NULL DEFAULT 'inventory'
    CHECK (product_type IN ('inventory', 'non_inventory', 'service')),

  -- Pricing
  cost_price NUMERIC(15,2) DEFAULT 0,
  selling_price NUMERIC(15,2) DEFAULT 0,
  cost_method TEXT NOT NULL DEFAULT 'weighted_average'
    CHECK (cost_method IN ('weighted_average', 'fifo')),
  tax_rate NUMERIC(5,2) DEFAULT 15,

  -- Stock management
  reorder_level NUMERIC(15,2) DEFAULT 0,
  reorder_quantity NUMERIC(15,2) DEFAULT 0,
  current_stock NUMERIC(15,2) DEFAULT 0,
  reserved_stock NUMERIC(15,2) DEFAULT 0,
  avg_cost NUMERIC(15,2) DEFAULT 0,

  -- GL accounts
  gl_inventory_account_id UUID REFERENCES gl_accounts(id),
  gl_cogs_account_id UUID REFERENCES gl_accounts(id),
  gl_revenue_account_id UUID REFERENCES gl_accounts(id),

  -- Status
  is_active BOOLEAN DEFAULT true,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);

-- ── Warehouses / Locations ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  address TEXT,
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, code)
);

-- ── Stock Levels (per product per warehouse) ─────────────────────────────

CREATE TABLE IF NOT EXISTS stock_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  quantity NUMERIC(15,2) DEFAULT 0,
  reserved NUMERIC(15,2) DEFAULT 0,
  avg_cost NUMERIC(15,2) DEFAULT 0,
  last_count_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_levels_product ON stock_levels(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_levels_warehouse ON stock_levels(warehouse_id);

-- ── Stock Movements (audit trail for all stock changes) ──────────────────

CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id),
  warehouse_id UUID REFERENCES warehouses(id),
  movement_type TEXT NOT NULL
    CHECK (movement_type IN (
      'purchase', 'sale', 'adjustment_in', 'adjustment_out',
      'transfer_in', 'transfer_out', 'write_off', 'count',
      'grn', 'return_in', 'return_out'
    )),
  quantity NUMERIC(15,2) NOT NULL,
  unit_cost NUMERIC(15,2) DEFAULT 0,
  total_cost NUMERIC(15,2) DEFAULT 0,
  reference_type TEXT,
  reference_id UUID,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(movement_type);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at);

-- ── Stock Adjustments ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  adjustment_number TEXT NOT NULL,
  adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  product_id UUID NOT NULL REFERENCES products(id),
  warehouse_id UUID REFERENCES warehouses(id),
  adjustment_type TEXT NOT NULL
    CHECK (adjustment_type IN ('increase', 'decrease', 'write_off', 'transfer', 'count')),
  quantity NUMERIC(15,2) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(15,2) DEFAULT 0,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'posted'
    CHECK (status IN ('draft', 'posted', 'reversed')),
  journal_entry_id UUID REFERENCES gl_journal_entries(id),
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_adj_product ON stock_adjustments(product_id);

-- Seed default warehouse
INSERT INTO warehouses (name, code, is_default, is_active)
VALUES ('Main Warehouse', 'MAIN', true, true)
ON CONFLICT DO NOTHING;

-- Seed product categories
INSERT INTO product_categories (name, code, description) VALUES
  ('Raw Materials', 'raw_materials', 'Raw materials and components'),
  ('Finished Goods', 'finished_goods', 'Completed products ready for sale'),
  ('Consumables', 'consumables', 'Office and operational consumables'),
  ('Services', 'services', 'Service-based items'),
  ('Spare Parts', 'spare_parts', 'Replacement parts and spares'),
  ('Packaging', 'packaging', 'Packaging materials'),
  ('Electronics', 'electronics', 'Electronic components and devices'),
  ('Stationery', 'stationery', 'Office stationery supplies')
ON CONFLICT (code) DO NOTHING;
