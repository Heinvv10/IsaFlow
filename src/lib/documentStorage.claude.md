# documentStorage.ts

## Purpose
Thin facade over Supabase Storage for captured-document bytes — plus a SHA-256 helper. Abstracts "where the bytes live" so ingress/egress code doesn't reach into the Storage SDK directly.

## Key exports
- `sha256(buffer: Buffer): string` — crypto.createHash('sha256') hex digest.
- `storeCapturedBytes(companyId, documentId, buffer, contentType): Promise<StoredDocument>` — uploads to the `captured-documents` bucket under `<companyId>/<documentId>`, returns `{ documentId, bucket, path, hash, size }`. Caller is responsible for writing the pointer onto `captured_documents`.
- `fetchRawBytes(documentId, companyId): Promise<RawBytes | null>` — reads `storage_bucket` + `storage_path` from `captured_documents`, downloads via the Storage SDK, returns `{ buffer, hash, size, fileType }`. Returns null when no pointer is set (legacy / pre-migration row).

## Dependencies
- `node:crypto` — SHA-256.
- `./neon` (sql) — reads the DB pointer in `fetchRawBytes`.
- `./supabaseStorage` — `uploadCapturedDocument` + `downloadCapturedDocument` + `CAPTURED_DOCS_BUCKET`.

## Critical notes
- **Hash is an integrity seal**, not a content-addressing key. `captured_documents.raw_bytes_sha256` is set by the ingress path (email / pwa / whatsapp) and carried into `gl_journal_entries.source_document_hash` on evidenced JEs (PRD-05 Phase 2).
- **Paths are company-namespaced** — `<companyId>/<documentId>`. Cross-tenant access requires a service-role key (which this module uses server-side only).
- **`raw_bytes_sha256` + `raw_bytes_size` columns** exist on `captured_documents` (migration 410) even though the bytes themselves now live in Storage (migration 411 removed the BYTEA fallback). The size stays in the DB to avoid a Storage round-trip for the UI.
- `fetchRawBytes` fabricates a fresh hash if the DB column is null — useful during the legacy-row transition window but will disagree with any persisted hash on a newly-ingested row by design (should always match in practice).

## Recent changes
- 2026-04-22: Created as the Phase 1 deferral closeout (commit d043a22), then swapped from BYTEA to Supabase Storage (commit d55b296).
