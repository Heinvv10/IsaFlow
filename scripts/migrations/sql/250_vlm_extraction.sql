-- 250: VLM document extraction tables + validation audit trail
-- Creates missing document storage tables and adds extracted_data JSONB columns.

-- Accounting entity documents (supplier invoices, payments, etc.)
CREATE TABLE IF NOT EXISTS procurement_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  document_type VARCHAR(50) DEFAULT 'other',
  document_name VARCHAR(500),
  file_url TEXT,
  file_path TEXT,
  file_size INTEGER,
  mime_type VARCHAR(100),
  uploaded_by VARCHAR(255),
  uploaded_by_name VARCHAR(255),
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  extracted_data JSONB,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proc_docs_entity ON procurement_documents(entity_type, entity_id);

-- Cross-links between documents and entities
CREATE TABLE IF NOT EXISTS document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES procurement_documents(id),
  linked_entity_type VARCHAR(50) NOT NULL,
  linked_entity_id UUID NOT NULL,
  link_reason VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_id, linked_entity_type, linked_entity_id)
);

-- Bank transaction receipt/proof attachments
CREATE TABLE IF NOT EXISTS bank_transaction_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id UUID NOT NULL,
  file_url TEXT,
  file_name VARCHAR(500),
  file_size INTEGER,
  uploaded_by UUID,
  extracted_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bta_tx ON bank_transaction_attachments(bank_transaction_id);

-- Company statutory documents — add extracted_data if missing
ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS extracted_data JSONB;

-- Document validation audit trail
CREATE TABLE IF NOT EXISTS document_validation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  document_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  validation_type VARCHAR(50) NOT NULL,
  result_data JSONB NOT NULL DEFAULT '{}',
  discrepancy_count INT NOT NULL DEFAULT 0,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validated_by UUID
);

CREATE INDEX IF NOT EXISTS idx_dvr_company ON document_validation_results(company_id);
CREATE INDEX IF NOT EXISTS idx_dvr_entity ON document_validation_results(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_dvr_document ON document_validation_results(document_id);
