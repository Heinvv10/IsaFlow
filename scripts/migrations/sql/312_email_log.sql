-- Migration 312: Email Delivery Log
-- Persists every outbound email attempt for audit and admin review.

CREATE TABLE IF NOT EXISTS email_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  subject         TEXT NOT NULL,
  email_type      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent', 'failed', 'bounced')),
  error_message   TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_by         VARCHAR REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_email_log_company
  ON email_log(company_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_log_status
  ON email_log(status, sent_at DESC);

COMMENT ON TABLE email_log IS
  'Audit log of every outbound email attempt — type, status, recipient, and optional error.';
