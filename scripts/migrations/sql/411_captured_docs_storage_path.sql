-- PRD-05 Phase 1 follow-up: swap inline BYTEA storage for Supabase Storage.
--
-- Migration 410 added raw_bytes BYTEA as a pragmatic fallback because the
-- Supabase Storage bucket was not yet configured. It now is (bucket:
-- captured-documents on the IsaFlow self-hosted stack at SUPABASE_URL). The
-- app reads/writes via src/lib/supabaseStorage.ts; the DB just records the
-- pointer (bucket + path) plus the SHA-256 hash for integrity.

-- Add the pointer columns.
ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT,
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

CREATE INDEX IF NOT EXISTS idx_captured_docs_storage_path ON captured_documents(storage_path)
  WHERE storage_path IS NOT NULL;

-- Drop the inline-bytes column. Safe because migration 410 was never applied
-- to production (written and committed in the same session as this migration;
-- no data at risk). If any environment DID apply 410, DROP COLUMN IF EXISTS is
-- a no-op when the column is already absent.
ALTER TABLE captured_documents
  DROP COLUMN IF EXISTS raw_bytes;

-- raw_bytes_sha256 + raw_bytes_size are kept — the hash is the integrity seal
-- on the object in Storage, and the size is useful for the UI without a round-
-- trip to Storage.
