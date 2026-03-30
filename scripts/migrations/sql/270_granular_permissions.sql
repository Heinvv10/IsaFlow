-- Migration: Granular Module-Level Permissions (WS-4.1)
-- Creates permission_modules and company_user_permissions tables.

CREATE TABLE IF NOT EXISTS permission_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key VARCHAR(50) NOT NULL UNIQUE,
  module_name VARCHAR(100) NOT NULL,
  description TEXT,
  display_order INT DEFAULT 100
);

CREATE TABLE IF NOT EXISTS company_user_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_key VARCHAR(50) NOT NULL,
  can_read BOOLEAN DEFAULT false,
  can_write BOOLEAN DEFAULT false,
  can_delete BOOLEAN DEFAULT false,
  can_export BOOLEAN DEFAULT false,
  can_approve BOOLEAN DEFAULT false,
  account_range_from VARCHAR(20),
  account_range_to VARCHAR(20),
  restrictions JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, user_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_cup_company_user
  ON company_user_permissions(company_id, user_id);

CREATE INDEX IF NOT EXISTS idx_cup_module_key
  ON company_user_permissions(module_key);

-- Seed default modules
INSERT INTO permission_modules (module_key, module_name, display_order) VALUES
  ('dashboard',   'Dashboard',                     10),
  ('customers',   'Customers & AR',                20),
  ('suppliers',   'Suppliers & AP',                30),
  ('items',       'Items & Inventory',             40),
  ('banking',     'Banking & Reconciliation',      50),
  ('accounts',    'Chart of Accounts & GL',        60),
  ('vat',         'VAT & Tax',                     70),
  ('accountant',  'Accountant''s Area',            80),
  ('reports',     'Reports',                       90),
  ('sars',        'SARS Compliance',              100),
  ('tools',       'Tools & Settings',             110),
  ('group',       'Group Consolidation',          120),
  ('payroll',     'Payroll',                      130)
ON CONFLICT (module_key) DO NOTHING;
