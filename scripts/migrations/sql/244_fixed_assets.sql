-- Fixed Asset Register & Management
-- Sprint 1: Full asset lifecycle with SARS wear-and-tear categories

CREATE TABLE IF NOT EXISTS asset_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  sars_rate NUMERIC(6,2) NOT NULL,
  sars_years INTEGER NOT NULL,
  description TEXT,
  gl_asset_account_id UUID REFERENCES gl_accounts(id),
  gl_depreciation_account_id UUID REFERENCES gl_accounts(id),
  gl_expense_account_id UUID REFERENCES gl_accounts(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO asset_categories (name, code, sars_rate, sars_years, description)
VALUES
  ('Computers', 'computers', 33.33, 3, 'Computers, laptops, tablets, and peripheral devices'),
  ('Motor Vehicles', 'motor_vehicles', 20, 5, 'Motor vehicles used for business purposes'),
  ('Furniture', 'furniture', 16.67, 6, 'Office furniture, desks, chairs, shelving'),
  ('Office Equipment', 'office_equipment', 20, 5, 'Printers, copiers, telephones, fax machines'),
  ('Buildings', 'buildings', 5, 20, 'Commercial buildings and improvements'),
  ('Machinery', 'machinery', 12.5, 8, 'General machinery and plant equipment'),
  ('Manufacturing Equipment', 'manufacturing_equipment', 25, 4, 'Manufacturing plant and equipment (Section 12C)'),
  ('Small Tools', 'small_tools', 50, 2, 'Small tools, implements, and utensils'),
  ('Aircraft', 'aircraft', 25, 4, 'Aircraft used for business purposes'),
  ('Electronic Equipment', 'electronic_equipment', 25, 4, 'Electronic equipment, servers, networking gear'),
  ('Signage', 'signage', 10, 10, 'Business signage, billboards, displays'),
  ('Leasehold Improvements', 'leasehold_improvements', 20, 5, 'Leasehold improvements (or lease term if shorter)')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  asset_number TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category_id UUID REFERENCES asset_categories(id),
  category TEXT,
  serial_number TEXT,
  barcode TEXT,
  location TEXT,
  assigned_to TEXT,
  purchase_date DATE NOT NULL,
  purchase_price NUMERIC(15,2) NOT NULL CHECK (purchase_price > 0),
  salvage_value NUMERIC(15,2) DEFAULT 0 CHECK (salvage_value >= 0),
  useful_life_years NUMERIC(5,2) NOT NULL CHECK (useful_life_years > 0),
  depreciation_method TEXT NOT NULL DEFAULT 'straight_line'
    CHECK (depreciation_method IN ('straight_line', 'reducing_balance', 'sum_of_years')),
  sars_category TEXT,
  sars_rate NUMERIC(6,2),
  tax_useful_life_years NUMERIC(5,2),
  tax_depreciation_method TEXT DEFAULT 'straight_line',
  accumulated_depreciation NUMERIC(15,2) DEFAULT 0,
  current_book_value NUMERIC(15,2),
  tax_accumulated_depreciation NUMERIC(15,2) DEFAULT 0,
  tax_book_value NUMERIC(15,2),
  last_depreciation_date DATE,
  gl_asset_account_id UUID REFERENCES gl_accounts(id),
  gl_depreciation_account_id UUID REFERENCES gl_accounts(id),
  gl_expense_account_id UUID REFERENCES gl_accounts(id),
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'assigned', 'in_maintenance', 'disposed', 'written_off')),
  disposal_date DATE,
  disposal_method TEXT CHECK (disposal_method IN ('sale', 'scrap', 'write_off', 'donation', 'theft', 'insurance_claim')),
  disposal_amount NUMERIC(15,2),
  disposal_reason TEXT,
  disposal_gain_loss NUMERIC(15,2),
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, asset_number)
);

CREATE INDEX IF NOT EXISTS idx_assets_company ON assets(company_id);
CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category_id);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
CREATE INDEX IF NOT EXISTS idx_assets_number ON assets(asset_number);

CREATE TABLE IF NOT EXISTS asset_depreciation_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  period_date DATE NOT NULL,
  depreciation_method TEXT NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  accumulated_total NUMERIC(15,2) NOT NULL,
  book_value_after NUMERIC(15,2) NOT NULL,
  journal_entry_id UUID REFERENCES gl_journal_entries(id),
  is_tax BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dep_schedule_asset ON asset_depreciation_schedule(asset_id);
CREATE INDEX IF NOT EXISTS idx_dep_schedule_period ON asset_depreciation_schedule(period_date);

CREATE TABLE IF NOT EXISTS asset_disposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id),
  disposal_date DATE NOT NULL,
  disposal_method TEXT NOT NULL,
  disposal_amount NUMERIC(15,2) DEFAULT 0,
  book_value_at_disposal NUMERIC(15,2) NOT NULL,
  gain_loss NUMERIC(15,2) NOT NULL,
  reason TEXT,
  journal_entry_id UUID REFERENCES gl_journal_entries(id),
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disposals_asset ON asset_disposals(asset_id);

CREATE OR REPLACE FUNCTION set_asset_book_value()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_book_value IS NULL THEN
    NEW.current_book_value := NEW.purchase_price;
  END IF;
  IF NEW.tax_book_value IS NULL THEN
    NEW.tax_book_value := NEW.purchase_price;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_book_value ON assets;
CREATE TRIGGER trg_asset_book_value
  BEFORE INSERT ON assets
  FOR EACH ROW EXECUTE FUNCTION set_asset_book_value();
