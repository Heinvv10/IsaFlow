-- 441_customer_supplier_categories.sql
-- Restore customer_categories + supplier_categories tables lost in the
-- Supabase cutover, plus customers.category (supplier.category already
-- survived). Endpoints:
--   /api/accounting/customer-categories (GET/POST/PUT/DELETE, nav link live)
--   /api/accounting/supplier-categories (GET/POST/PUT/DELETE, nav link live)
-- Both still have swallow-catch blocks for "does not exist" which masks
-- the real failure from users; restoring the tables makes the feature
-- work as designed.

-- ── customer_categories ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_customer_categories_company
  ON customer_categories(company_id, name);

CREATE OR REPLACE FUNCTION customer_categories_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_categories_touch ON customer_categories;
CREATE TRIGGER trg_customer_categories_touch
  BEFORE UPDATE ON customer_categories
  FOR EACH ROW EXECUTE FUNCTION customer_categories_touch_updated_at();

ALTER TABLE customer_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_categories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON customer_categories;
CREATE POLICY tenant_isolation ON customer_categories
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_categories TO app_user;

-- ── supplier_categories ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_supplier_categories_company
  ON supplier_categories(company_id, name);

CREATE OR REPLACE FUNCTION supplier_categories_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_supplier_categories_touch ON supplier_categories;
CREATE TRIGGER trg_supplier_categories_touch
  BEFORE UPDATE ON supplier_categories
  FOR EACH ROW EXECUTE FUNCTION supplier_categories_touch_updated_at();

ALTER TABLE supplier_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_categories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON supplier_categories;
CREATE POLICY tenant_isolation ON supplier_categories
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_categories TO app_user;

-- ── customers.category column (LEFT JOIN target in the list query) ───────

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS category TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_category
  ON customers(company_id, category)
  WHERE category IS NOT NULL;
