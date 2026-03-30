-- Migration 273: Custom Report Builder
-- WS-7.1 from PRD-MARNEWECK-ROADMAP

CREATE TABLE IF NOT EXISTS custom_report_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by VARCHAR(255) NOT NULL REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  data_source VARCHAR(50) NOT NULL CHECK (data_source IN (
    'gl_transactions', 'customer_invoices', 'supplier_invoices',
    'bank_transactions', 'items', 'customers', 'suppliers',
    'ar_aging', 'ap_aging', 'trial_balance', 'budget_vs_actual'
  )),
  columns JSONB NOT NULL DEFAULT '[]',
  filters JSONB NOT NULL DEFAULT '[]',
  sort_by JSONB DEFAULT '[]',
  group_by JSONB DEFAULT '[]',
  totals JSONB DEFAULT '{}',
  layout_options JSONB DEFAULT '{}',
  is_shared BOOLEAN DEFAULT false,
  schedule JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_reports_company ON custom_report_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_custom_reports_user ON custom_report_templates(created_by);
CREATE INDEX IF NOT EXISTS idx_custom_reports_company_shared ON custom_report_templates(company_id, is_shared);
