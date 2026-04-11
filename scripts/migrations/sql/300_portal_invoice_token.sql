-- Migration 300: Add portal_token to customer_invoices for secure shareable invoice view links
-- Customers can view their invoice without logging in using the token URL.

ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS portal_token    VARCHAR(64) UNIQUE,
  ADD COLUMN IF NOT EXISTS portal_viewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portal_paid_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customer_invoices_portal_token
  ON customer_invoices(portal_token)
  WHERE portal_token IS NOT NULL;

COMMENT ON COLUMN customer_invoices.portal_token     IS 'Secure random token for public invoice view link — no auth required';
COMMENT ON COLUMN customer_invoices.portal_viewed_at IS 'Timestamp of first customer view via portal link';
COMMENT ON COLUMN customer_invoices.portal_paid_at   IS 'Timestamp when invoice was paid via portal';
