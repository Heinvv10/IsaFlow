-- Migration 342: Magic link tokens for portal authentication
-- Single-use, 15-minute expiry tokens sent to portal contacts by email.

CREATE TABLE IF NOT EXISTS portal_magic_links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  uuid        NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  token       text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_token
  ON portal_magic_links(token);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_contact_id
  ON portal_magic_links(contact_id);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_company_id
  ON portal_magic_links(company_id);
