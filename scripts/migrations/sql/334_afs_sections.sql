-- 334_afs_sections.sql
-- One record per statement/note within an AfsDocument.

CREATE TABLE IF NOT EXISTS afs_sections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id             UUID NOT NULL REFERENCES afs_documents(id) ON DELETE CASCADE,
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  section_type            TEXT NOT NULL,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'auto_generated', 'ai_enhanced', 'reviewed', 'signed_off')),
  data_snapshot           JSONB,
  content                 JSONB,
  overrides               JSONB,
  ai_narrative            TEXT,
  ai_narrative_accepted   BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by             TEXT REFERENCES users(id),
  reviewed_at             TIMESTAMPTZ,
  signed_off_by           TEXT REFERENCES users(id),
  signed_off_at           TIMESTAMPTZ,
  version_history         JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_sections_document_id
  ON afs_sections(document_id);

CREATE INDEX IF NOT EXISTS idx_afs_sections_document_type
  ON afs_sections(document_id, section_type);

CREATE INDEX IF NOT EXISTS idx_afs_sections_status
  ON afs_sections(document_id, status);

-- One section of each type per document
CREATE UNIQUE INDEX IF NOT EXISTS uq_afs_sections_document_type
  ON afs_sections(document_id, section_type);

CREATE INDEX IF NOT EXISTS idx_afs_sections_company_id
  ON afs_sections(company_id);
