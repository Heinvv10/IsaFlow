-- 681_afs_signing_content_fingerprint.sql
-- A document out for signature is signed as it stood when it was sent. The send records a
-- fingerprint of every section's content and review state; the Signum webhook signs the
-- document off only when the fingerprint still matches, and otherwise refuses with a reason
-- recorded here and hands the document back for a fresh send.

ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_content_fingerprint TEXT;
ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_refused_at TIMESTAMPTZ;
ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_refused_reason TEXT;

COMMENT ON COLUMN afs_documents.signing_content_fingerprint IS
  'sha256 of every section''s content and review state at send-for-signing; the signature webhook compares it';
COMMENT ON COLUMN afs_documents.signing_refused_reason IS
  'Why the last signature was not accepted (content changed since it was sent, or a section not signed off)';
