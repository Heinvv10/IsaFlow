-- 250: VLM document extraction columns + validation audit trail
-- Adds extracted_data JSONB to tables that store uploaded documents,
-- enabling AI-powered extraction storage and document validation.

-- Accounting entity documents (supplier invoices, payments, etc.)
ALTER TABLE procurement_documents ADD COLUMN IF NOT EXISTS extracted_data JSONB;

-- Bank transaction receipt/proof attachments
ALTER TABLE bank_transaction_attachments ADD COLUMN IF NOT EXISTS extracted_data JSONB;

-- Company statutory documents (CIPC, tax clearance, B-BBEE, VAT cert)
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
