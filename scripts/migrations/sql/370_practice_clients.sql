-- 370_practice_clients.sql
-- Practice CRM: client registry distinct from AR customers

CREATE TABLE IF NOT EXISTS practice_client_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcg_company ON practice_client_groups(company_id);

CREATE TABLE IF NOT EXISTS practice_clients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL,
  legal_name          TEXT NOT NULL,
  trading_name        TEXT,
  registration_no     TEXT,
  tax_no              TEXT,
  client_group_id     UUID REFERENCES practice_client_groups(id),
  assigned_partner_id UUID,
  assigned_manager_id UUID,
  billing_model       TEXT NOT NULL DEFAULT 'hourly'
                        CHECK (billing_model IN ('hourly','fixed','retainer')),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('prospect','onboarding','active','inactive','archived')),
  link_customer_id    UUID,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pc_company        ON practice_clients(company_id);
CREATE INDEX IF NOT EXISTS idx_pc_company_status ON practice_clients(company_id, status);
CREATE INDEX IF NOT EXISTS idx_pc_group          ON practice_clients(company_id, client_group_id);

CREATE TABLE IF NOT EXISTS practice_client_contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  client_id  UUID NOT NULL REFERENCES practice_clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  role       TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcc_client ON practice_client_contacts(client_id);
