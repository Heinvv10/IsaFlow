-- Onboarding support: company documents table + user onboarding flag

-- Track whether a user has completed the onboarding wizard
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;

-- Backfill: existing users who already have a company are considered onboarded
UPDATE users u
SET onboarding_completed = true
WHERE EXISTS (
  SELECT 1 FROM company_users cu WHERE cu.user_id::TEXT = u.id
);

-- Statutory documents linked to a company (CIPC, tax clearance, B-BBEE, VAT reg)
CREATE TABLE IF NOT EXISTS company_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'cipc_certificate',
    'tax_clearance',
    'bbbee_certificate',
    'vat_registration',
    'other'
  )),
  document_name TEXT NOT NULL,
  file_data TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_company_docs_company ON company_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_company_docs_type ON company_documents(document_type);
