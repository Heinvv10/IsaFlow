-- Migration 295: Customer Contacts
-- Adds support for multiple contacts per customer (Sage parity)

CREATE TABLE IF NOT EXISTS customer_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(100),
  email VARCHAR(255),
  phone VARCHAR(50),
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_contacts_customer_id_idx ON customer_contacts(customer_id);
CREATE INDEX IF NOT EXISTS customer_contacts_company_id_idx ON customer_contacts(company_id);
