-- Multi-Entity / Multi-Company Support
-- Each company has its own data, users can switch between companies

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  trading_name TEXT,
  registration_number TEXT,
  vat_number TEXT,
  tax_number TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'South Africa',
  phone TEXT,
  email TEXT,
  website TEXT,
  logo_url TEXT,
  bank_name TEXT,
  bank_account_number TEXT,
  bank_branch_code TEXT,
  bank_account_type TEXT DEFAULT 'current',
  financial_year_start INTEGER DEFAULT 3, -- month (1-12), default March
  vat_period TEXT DEFAULT 'bi-monthly', -- monthly, bi-monthly
  default_currency TEXT DEFAULT 'ZAR',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- owner, admin, accountant, user, viewer
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_company_users_user ON company_users(user_id);
CREATE INDEX IF NOT EXISTS idx_company_users_company ON company_users(company_id);

-- Seed a default company
INSERT INTO companies (id, name, trading_name, country)
VALUES ('00000000-0000-0000-0000-000000000001', 'My Company', 'My Company', 'South Africa')
ON CONFLICT (id) DO NOTHING;
