-- Migration 341: Portal contacts for client portal access
-- Stores directors, CFOs, shareholders, and auditors who access the client portal.

CREATE TABLE IF NOT EXISTS portal_contacts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  email       text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('director', 'cfo', 'shareholder_readonly', 'external_auditor')),
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, email)
);

CREATE INDEX IF NOT EXISTS idx_portal_contacts_company_id
  ON portal_contacts(company_id);

CREATE INDEX IF NOT EXISTS idx_portal_contacts_email
  ON portal_contacts(email);
