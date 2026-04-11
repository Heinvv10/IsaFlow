-- Migration 294: Customer Delivery Addresses
-- Adds support for multiple named delivery addresses per customer (Sage parity)

CREATE TABLE IF NOT EXISTS customer_delivery_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  address_name VARCHAR(100) NOT NULL,
  address_line1 VARCHAR(255),
  address_line2 VARCHAR(255),
  city VARCHAR(100),
  province VARCHAR(100),
  postal_code VARCHAR(20),
  country VARCHAR(100) DEFAULT 'South Africa',
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns if they don't exist (idempotent for re-runs)
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS address_name VARCHAR(100);
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255);
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS province VARCHAR(100);
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20);
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS country VARCHAR(100) DEFAULT 'South Africa';
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;
ALTER TABLE customer_delivery_addresses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS customer_delivery_addresses_customer_id_idx ON customer_delivery_addresses(customer_id);
CREATE INDEX IF NOT EXISTS customer_delivery_addresses_company_id_idx ON customer_delivery_addresses(company_id);
