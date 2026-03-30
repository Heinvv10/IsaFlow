-- Migration 277: Recurring Transaction Templates
-- WS-8.4: Recurring Transactions

CREATE TABLE IF NOT EXISTS recurring_transaction_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  entity_type VARCHAR(50) NOT NULL CHECK (entity_type IN (
    'journal_entry', 'customer_invoice', 'supplier_invoice'
  )),
  template_data JSONB NOT NULL DEFAULT '{}',
  frequency VARCHAR(20) NOT NULL CHECK (frequency IN (
    'daily', 'weekly', 'monthly', 'quarterly', 'annually'
  )),
  next_run_date DATE,
  last_run_date DATE,
  is_active BOOLEAN DEFAULT true,
  auto_post BOOLEAN DEFAULT false,
  created_by VARCHAR(255) NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_company ON recurring_transaction_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_recurring_next_run ON recurring_transaction_templates(next_run_date)
  WHERE is_active = true;
