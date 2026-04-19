-- Migration 361: Enhance assets table with Phase 1 FAR fields
-- Adds: custodian, production_code, cost_centre_id, tax_opening_acc_dep,
--       deferred_tax_rate, below_threshold, disposal_type
-- Note: serial_number, location, status, tax_useful_life_years,
--       tax_accumulated_depreciation, tax_book_value, disposal_date,
--       disposal_method already exist from migration 244.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS custodian             TEXT,
  ADD COLUMN IF NOT EXISTS production_code       TEXT,
  ADD COLUMN IF NOT EXISTS cost_centre_id        UUID REFERENCES cost_centres(id),
  ADD COLUMN IF NOT EXISTS tax_opening_acc_dep   NUMERIC(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deferred_tax_rate     NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS below_threshold       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS disposal_type         TEXT
    CHECK (disposal_type IN ('sale','write_off','donation','theft','loss') OR disposal_type IS NULL);

CREATE INDEX IF NOT EXISTS idx_assets_cost_centre ON assets(cost_centre_id);
CREATE INDEX IF NOT EXISTS idx_assets_below_threshold ON assets(company_id, below_threshold);
