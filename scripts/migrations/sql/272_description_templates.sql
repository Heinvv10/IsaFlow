-- Migration 272: Transaction Description Templates
-- WS-6.5: Description Templates & Auto-Suggest

CREATE TABLE IF NOT EXISTS transaction_description_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  template TEXT NOT NULL,
  entity_type VARCHAR(50),
  usage_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_desc_templates_company
  ON transaction_description_templates(company_id);

CREATE INDEX IF NOT EXISTS idx_desc_templates_entity
  ON transaction_description_templates(company_id, entity_type);
