-- Migration 305: Supplier Activities
-- Stores timeline activities (notes, calls, emails, etc.) for suppliers.
-- Mirrors customer_activities with supplier_id instead of customer_id.

CREATE TABLE IF NOT EXISTS supplier_activities (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID  NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  supplier_id  UUID  NOT NULL REFERENCES suppliers(id)  ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (activity_type IN (
    'note', 'call', 'email_sent', 'email_received',
    'payment_made', 'invoice_received', 'status_change'
  )),
  subject      TEXT,
  description  TEXT  NOT NULL,
  created_by   VARCHAR NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_activities_supplier
  ON supplier_activities(company_id, supplier_id, created_at DESC);
