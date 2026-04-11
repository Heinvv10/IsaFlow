-- Migration 304: Supplier Contacts
-- Adds support for multiple contacts per supplier (mirrors customer_contacts, Sage parity)

CREATE TABLE IF NOT EXISTS supplier_contacts (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID        NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  company_id  UUID        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  full_name   VARCHAR(255) NOT NULL,
  role        VARCHAR(100),
  email       VARCHAR(255),
  phone       VARCHAR(50),
  is_primary  BOOLEAN      DEFAULT false,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS supplier_contacts_supplier_id_idx ON supplier_contacts(supplier_id);
CREATE INDEX IF NOT EXISTS supplier_contacts_company_id_idx  ON supplier_contacts(company_id);
