-- Migration 343: Signum integration columns on afs_documents
-- Adds signum_document_id, signed_pdf_path, and signing_requested_at.

ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signum_document_id text;
ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signed_pdf_path text;
ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_requested_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_afs_documents_signum_document_id
  ON afs_documents(signum_document_id)
  WHERE signum_document_id IS NOT NULL;
