-- PRD-05 Phase 1 follow-up: persist raw file bytes + SHA-256 on captured_documents.
--
-- Supabase Storage is not wired in this project, but BYTEA with Postgres TOAST
-- compression handles the typical 100–500KB slip size fine, stays transactional
-- with the metadata, and avoids a new infra surface. When volume demands it, a
-- later migration can move the bytes to object storage and replace raw_bytes
-- with raw_payload_url — the read-path helper (src/lib/documentStorage.ts)
-- abstracts the source so the swap is a single-file change.

ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS raw_bytes BYTEA,
  ADD COLUMN IF NOT EXISTS raw_bytes_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS raw_bytes_size INTEGER;

CREATE INDEX IF NOT EXISTS idx_captured_docs_sha256 ON captured_documents(raw_bytes_sha256)
  WHERE raw_bytes_sha256 IS NOT NULL;

-- Also propagate the hash onto supplier_invoices / gl_journal_entries when the
-- pipeline runs — that's a write-path code change, not a data migration.
