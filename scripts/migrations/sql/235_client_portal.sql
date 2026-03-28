-- Client Portal
-- Customer self-service: view invoices, statements, make payments

CREATE TABLE IF NOT EXISTS portal_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(email)
);

CREATE TABLE IF NOT EXISTS portal_payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL,
  client_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  status TEXT DEFAULT 'active', -- active, paid, expired, cancelled
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  paid_at TIMESTAMPTZ,
  payment_reference TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_access_email ON portal_access(email);
CREATE INDEX IF NOT EXISTS idx_portal_access_client ON portal_access(client_id);
CREATE INDEX IF NOT EXISTS idx_portal_payment_links_token ON portal_payment_links(token);
