-- 683_afs_pack_delivery_withheld.sql
-- Two things a row must carry rather than a return value.
--
-- 1. A management pack generated with review SKIPPED (review_required = false) has no
--    signature and no reviewer. It is generated, so a person can open it, but it must not be
--    DELIVERED until someone signs the document off. The reason lives on the document, where
--    deliverPack (the one place every delivery passes through) reads it; signing the document
--    off clears it and writes an audit row. Nothing else clears it.
--
-- 2. A digest per rendered input (document, company, brand, sections), recorded at send, so a
--    refused signature can name WHICH input changed. Nothing is back-filled: see 682.
--
-- DEPLOY NOTE: rolling the CODE back with this migration applied fails OPEN — the previous
-- deliverPack does not read delivery_withheld_reason, so a held pack becomes deliverable.

ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS delivery_withheld_reason TEXT;
ALTER TABLE afs_documents ADD COLUMN IF NOT EXISTS signing_input_digests JSONB;

COMMENT ON COLUMN afs_documents.delivery_withheld_reason IS
  'Why this pack may not be delivered yet; cleared only by a document sign-off, which audits the release';
COMMENT ON COLUMN afs_documents.signing_input_digests IS
  'sha256 per rendered input (document, company, brand, sections) at send-for-signing; lets a refusal name what changed';
