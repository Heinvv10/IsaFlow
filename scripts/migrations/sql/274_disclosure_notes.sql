-- Migration 274: IFRS Disclosure Notes + CaseWare Account Mappings
-- WS-7.2 Disclosure Notes manual table
-- WS-7.3 CaseWare account external mapping table

CREATE TABLE IF NOT EXISTS disclosure_notes_manual (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year INT NOT NULL,
  note_number INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  created_by VARCHAR(255) NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, fiscal_year, note_number)
);

CREATE INDEX IF NOT EXISTS idx_disclosure_notes_company
  ON disclosure_notes_manual(company_id, fiscal_year);

-- CaseWare / XBRL / Custom account code mapping
CREATE TABLE IF NOT EXISTS account_external_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  target_system VARCHAR(50) NOT NULL CHECK (target_system IN ('caseware', 'xbrl', 'custom')),
  external_code VARCHAR(100) NOT NULL,
  external_label VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, gl_account_id, target_system)
);

CREATE INDEX IF NOT EXISTS idx_ext_mapping_company
  ON account_external_mapping(company_id);

CREATE INDEX IF NOT EXISTS idx_ext_mapping_gl_account
  ON account_external_mapping(gl_account_id);
