-- Migration 268: Soft Delete / Undo System
-- Adds deleted_at to entities that support undo (WS-1.2 from PRD)
-- Records are kept for 5 minutes, then purged by background job

ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- bank_rules may not exist yet; wrap in DO block
DO $$ BEGIN
  ALTER TABLE bank_rules ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes — only index non-deleted rows (the common query path)
CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_active ON items(company_id) WHERE deleted_at IS NULL;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_bank_rules_active ON bank_rules(company_id) WHERE deleted_at IS NULL;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_customer_invoices_active ON customer_invoices(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_active ON supplier_invoices(company_id) WHERE deleted_at IS NULL;
