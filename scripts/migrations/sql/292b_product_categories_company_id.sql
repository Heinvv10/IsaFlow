-- BL-02: Add tenant scoping to product_categories.
-- Existing 8 seed rows keep company_id=NULL (system seed, visible to all tenants).
-- Future per-tenant categories set company_id to the owning company.
ALTER TABLE product_categories
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_product_categories_company
  ON product_categories (company_id);
