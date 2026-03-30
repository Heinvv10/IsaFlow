-- Company directors table — stores director/member details per company
CREATE TABLE IF NOT EXISTS company_directors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  id_number TEXT,
  role TEXT NOT NULL DEFAULT 'Director',
  id_document_name TEXT,
  id_document_data TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_directors_company ON company_directors(company_id);
