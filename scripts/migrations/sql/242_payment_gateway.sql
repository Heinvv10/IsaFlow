-- Payment gateway integration for online invoice payments

CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  invoice_id UUID,
  payment_link_id UUID,
  gateway TEXT NOT NULL DEFAULT 'payfast',
  gateway_ref TEXT,                       -- PayFast m_payment_id or pf_payment_id
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ZAR',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','cancelled','refunded')),
  customer_id UUID,
  customer_email TEXT,
  customer_name TEXT,
  payment_method TEXT,                    -- cc, eft, mobicred, etc.
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_tx_company ON payment_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_invoice ON payment_transactions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_gateway_ref ON payment_transactions(gateway_ref);
CREATE INDEX IF NOT EXISTS idx_payment_tx_status ON payment_transactions(company_id, status);

-- Add payment tracking columns to customer_invoices
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS payment_url TEXT;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS online_payment_enabled BOOLEAN DEFAULT false;
