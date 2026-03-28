-- Approval Workflows
-- Configurable approval rules for invoices, payments, journal entries, credit notes

CREATE TABLE IF NOT EXISTS approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  document_type TEXT NOT NULL, -- 'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note'
  condition_field TEXT NOT NULL DEFAULT 'total', -- 'total', 'amount'
  condition_operator TEXT NOT NULL DEFAULT 'greater_than', -- 'greater_than', 'greater_equal', 'any'
  condition_value NUMERIC(15,2) DEFAULT 0,
  approver_role TEXT NOT NULL DEFAULT 'admin', -- 'admin', 'manager', 'accountant'
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES approval_rules(id),
  document_type TEXT NOT NULL,
  document_id UUID NOT NULL,
  document_reference TEXT, -- INV-001, JE-042, etc.
  amount NUMERIC(15,2),
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected, cancelled
  requested_by UUID NOT NULL,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  decision_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed some default rules
INSERT INTO approval_rules (name, document_type, condition_field, condition_operator, condition_value, approver_role) VALUES
('Large customer invoices', 'customer_invoice', 'total', 'greater_than', 50000, 'manager'),
('Large supplier invoices', 'supplier_invoice', 'total', 'greater_than', 50000, 'manager'),
('Large payments', 'payment', 'amount', 'greater_than', 100000, 'admin'),
('All journal entries', 'journal_entry', 'total', 'any', 0, 'accountant'),
('Credit notes over R10k', 'credit_note', 'total', 'greater_than', 10000, 'manager')
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_document ON approval_requests(document_type, document_id);
