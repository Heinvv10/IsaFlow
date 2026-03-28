-- Purchase Orders & GRN Workflow (Sprint 3)

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  po_number TEXT NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_delivery_date DATE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled')),
  subtotal NUMERIC(15,2) DEFAULT 0,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  total NUMERIC(15,2) DEFAULT 0,
  notes TEXT,
  reference TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, po_number)
);

CREATE INDEX IF NOT EXISTS idx_po_company ON purchase_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);

CREATE TABLE IF NOT EXISTS po_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(15,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(15,2) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(5,2) DEFAULT 15,
  line_total NUMERIC(15,2) NOT NULL,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  quantity_received NUMERIC(15,2) DEFAULT 0,
  quantity_invoiced NUMERIC(15,2) DEFAULT 0,
  gl_account_id UUID REFERENCES gl_accounts(id),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_po_items_product ON po_items(product_id);

CREATE TABLE IF NOT EXISTS goods_received_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  grn_number TEXT NOT NULL,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id),
  received_date DATE NOT NULL DEFAULT CURRENT_DATE,
  received_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('draft', 'received', 'inspected', 'accepted', 'rejected')),
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, grn_number)
);

CREATE INDEX IF NOT EXISTS idx_grn_company ON goods_received_notes(company_id);
CREATE INDEX IF NOT EXISTS idx_grn_po ON goods_received_notes(purchase_order_id);

CREATE TABLE IF NOT EXISTS grn_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id UUID NOT NULL REFERENCES goods_received_notes(id) ON DELETE CASCADE,
  po_item_id UUID NOT NULL REFERENCES po_items(id),
  product_id UUID REFERENCES products(id),
  quantity_received NUMERIC(15,2) NOT NULL DEFAULT 0,
  quantity_rejected NUMERIC(15,2) DEFAULT 0,
  quality_status TEXT DEFAULT 'accepted'
    CHECK (quality_status IN ('pending', 'accepted', 'rejected', 'partial')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grn_items_grn ON grn_items(grn_id);
CREATE INDEX IF NOT EXISTS idx_grn_items_po_item ON grn_items(po_item_id);

-- Update supplier_invoices to link to POs (fix orphaned FK references)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'supplier_invoices' AND column_name = 'purchase_order_id') THEN
    ALTER TABLE supplier_invoices ADD COLUMN purchase_order_id UUID REFERENCES purchase_orders(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'supplier_invoices' AND column_name = 'grn_id') THEN
    ALTER TABLE supplier_invoices ADD COLUMN grn_id UUID REFERENCES goods_received_notes(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'supplier_invoices' AND column_name = 'match_status') THEN
    ALTER TABLE supplier_invoices ADD COLUMN match_status TEXT DEFAULT 'unmatched'
      CHECK (match_status IN ('unmatched', 'po_matched', 'grn_matched', 'fully_matched'));
  END IF;
END $$;
