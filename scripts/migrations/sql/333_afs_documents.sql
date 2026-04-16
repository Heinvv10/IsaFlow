-- 333_afs_documents.sql
-- Core AFS document record. One per company per fiscal year (AFS)
-- or per company per month (management_pack).

CREATE TABLE IF NOT EXISTS afs_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year         INTEGER,
  period              TEXT,        -- 'YYYY-MM' for management packs
  document_type       TEXT NOT NULL CHECK (document_type IN ('afs', 'management_pack')),
  reporting_framework TEXT NOT NULL CHECK (reporting_framework IN ('ifrs_smes', 'full_ifrs')),
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'in_review', 'partner_review', 'signed_off', 'filed')),
  locked_at           TIMESTAMPTZ,
  locked_by           TEXT REFERENCES users(id),
  version             INTEGER NOT NULL DEFAULT 1,
  pis_score           NUMERIC(10, 2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_documents_company_id
  ON afs_documents(company_id);

CREATE INDEX IF NOT EXISTS idx_afs_documents_company_type_year
  ON afs_documents(company_id, document_type, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_afs_documents_status
  ON afs_documents(company_id, status);

-- Ensure one AFS per company per fiscal year, one pack per company per period
CREATE UNIQUE INDEX IF NOT EXISTS uq_afs_documents_company_year
  ON afs_documents(company_id, fiscal_year)
  WHERE document_type = 'afs' AND fiscal_year IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_afs_documents_company_period
  ON afs_documents(company_id, period)
  WHERE document_type = 'management_pack' AND period IS NOT NULL;
