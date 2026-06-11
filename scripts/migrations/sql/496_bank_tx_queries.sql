-- 496: WhatsApp client query loop (Dotbiz Workstream D)
-- Accountant flags a bank transaction → templated WhatsApp to the client →
-- the reply (text or slip photo) attaches back to the transaction.

CREATE TABLE IF NOT EXISTS bank_tx_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  to_number TEXT NOT NULL,                -- bare E.164 (+27...), no whatsapp: prefix
  message_body TEXT NOT NULL,
  message_sid TEXT,                       -- Twilio MessageSid when available
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent','replied','resolved','cancelled')),
  reply_text TEXT,
  reply_capture_event_id UUID REFERENCES capture_events(id) ON DELETE SET NULL,
  created_by UUID,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replied_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_btq_company_status ON bank_tx_queries(company_id, status);
CREATE INDEX IF NOT EXISTS idx_btq_bank_tx ON bank_tx_queries(bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_btq_open_number
  ON bank_tx_queries(company_id, to_number)
  WHERE status IN ('sent','replied');

-- Default client WhatsApp number per company (the firm's client = business owner)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS client_query_whatsapp TEXT;
