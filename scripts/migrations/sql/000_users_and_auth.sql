-- =====================================================
-- Migration 000: Users, Sessions, and Auth
-- Standalone accounting app authentication tables
-- =====================================================

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'viewer' CHECK (role IN ('super_admin', 'admin', 'manager', 'accountant', 'bookkeeper', 'viewer', 'system')),
  permissions JSONB DEFAULT '[]'::JSONB,
  phone VARCHAR(50),
  department VARCHAR(100),
  profile_picture TEXT,
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Covering index for auth queries
CREATE INDEX IF NOT EXISTS idx_users_auth_lookup
ON users(id, is_active)
INCLUDE (email, first_name, last_name, role, permissions, profile_picture, department);

-- User sessions
CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(500) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_composite ON user_sessions(id, token_hash, expires_at);

-- User permissions
CREATE TABLE IF NOT EXISTS user_permissions (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  granted BOOLEAN DEFAULT true,
  granted_by VARCHAR(255) REFERENCES users(id),
  granted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_user_permission UNIQUE (user_id, resource, action)
);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id ON user_permissions(user_id);

-- Customers table (standalone, replaces FibreFlow clients reference)
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  vat_number VARCHAR(50),
  registration_number VARCHAR(50),
  billing_address TEXT,
  shipping_address TEXT,
  contact_person VARCHAR(255),
  payment_terms INTEGER DEFAULT 30,
  credit_limit NUMERIC(15,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Suppliers table (standalone, replaces FibreFlow suppliers reference)
CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  vat_number VARCHAR(50),
  registration_number VARCHAR(50),
  address TEXT,
  contact_person VARCHAR(255),
  payment_terms INTEGER DEFAULT 30,
  bank_name VARCHAR(100),
  bank_account_number VARCHAR(50),
  bank_branch_code VARCHAR(20),
  bank_account_type VARCHAR(20),
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_suppliers_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Customer invoices (standalone, originally from FF migration 149)
CREATE TABLE IF NOT EXISTS customer_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  billing_period_start DATE,
  billing_period_end DATE,
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(15,2) DEFAULT 0,
  status VARCHAR(30) DEFAULT 'draft' CHECK (status IN (
    'draft', 'pending_approval', 'approved', 'sent',
    'paid', 'partially_paid', 'overdue', 'cancelled'
  )),
  invoice_date DATE DEFAULT CURRENT_DATE,
  due_date DATE,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  notes TEXT,
  internal_notes TEXT,
  project_id UUID,
  gl_journal_entry_id UUID,
  created_by VARCHAR(255) NOT NULL,
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ci_customer ON customer_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_ci_status ON customer_invoices(status);
CREATE INDEX IF NOT EXISTS idx_ci_date ON customer_invoices(invoice_date);

CREATE TABLE IF NOT EXISTS customer_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(10,2) DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  gl_account_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_customer_invoices_updated_at
  BEFORE UPDATE ON customer_invoices
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE users IS 'Standalone accounting app users';
COMMENT ON TABLE user_sessions IS 'Active user sessions with token hashes';
COMMENT ON TABLE customers IS 'Customer master data for AR';
COMMENT ON TABLE suppliers IS 'Supplier master data for AP';
COMMENT ON TABLE customer_invoices IS 'Customer invoices for AR';
