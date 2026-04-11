-- Migration 296: Customer Activities
-- Stores timeline activities (notes, calls, emails, payments, etc.) for customers.

CREATE TABLE IF NOT EXISTS customer_activities (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  activity_type TEXT      NOT NULL CHECK (activity_type IN (
    'note', 'call', 'email_sent', 'email_received',
    'payment_received', 'invoice_sent', 'status_change'
  )),
  subject     TEXT,
  description TEXT        NOT NULL,
  created_by  VARCHAR     NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_activities_customer
  ON customer_activities(company_id, customer_id, created_at DESC);
