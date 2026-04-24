# supabaseStorage.ts

## Purpose
Singleton `@supabase/storage-js` client for the self-hosted Supabase Storage at `${SUPABASE_URL}/storage/v1`, plus typed helpers for captured-documents and sealed customer-invoice PDF snapshots.

## Key exports
- `getStorageClient(): StorageClient` — lazily constructs and caches the storage client; throws if `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` missing
- `const CAPTURED_DOCS_BUCKET` — `SUPABASE_CAPTURED_DOCS_BUCKET` env or `'captured-documents'`
- `const CUSTOMER_INVOICES_BUCKET` — `SUPABASE_CUSTOMER_INVOICES_BUCKET` env or `'customer-invoices'`
- `interface UploadResult` — `{ bucket, path }`
- `uploadCapturedDocument(companyId, documentId, buffer, contentType): Promise<UploadResult>` — path `${companyId}/${documentId}`, `upsert: false`
- `uploadCustomerInvoicePdf(companyId, documentId, buffer): Promise<UploadResult>` — PRD-06 sealed invoice snapshot; path `${companyId}/${documentId}.pdf`; auto-provisions bucket on first call
- `ensureCustomerInvoicesBucket(): Promise<void>` — idempotent lazy provisioner (swallows "already exists"); cached via module-level boolean
- `downloadCapturedDocument(bucket, path): Promise<Buffer>` — works for either bucket despite the name
- `removeCapturedDocument(bucket, path): Promise<void>` — best-effort; log-warn on failure
- `signedUrlForCapturedDocument(bucket, path, expiresInSeconds?=3600): Promise<string>` — short-lived signed URL for UI preview

## Dependencies
- `@supabase/storage-js@^2` — installed 2026-04-22
- `./logger`

## Critical notes
- **Server-only**: authenticates with `SUPABASE_SERVICE_ROLE_KEY`. Never import from client components or expose the client.
- Bucket paths are **tenant-scoped** by prefix (`${companyId}/...`). Do NOT upload outside the company prefix — downstream listing/authz relies on it. The private `uploadToBucket` helper is internal; keep the two public upload functions as the only path.
- `upsert: false` on upload — re-uploading an existing path throws. Callers must delete first if replacing.
- **Captured-docs bucket must be pre-provisioned** on each target stack (private, 10MB cap, mime allowlist PDF/JPEG/PNG/WebP/TIFF). Production needs the manual POST `/storage/v1/bucket` step before first upload — see prod deploy checklist.
- **Customer-invoices bucket is lazy-provisioned** — first call to `uploadCustomerInvoicePdf` creates it automatically via `ensureCustomerInvoicesBucket`. The "already exists" error is swallowed as success; any other failure logs a warn and continues (non-fatal — the subsequent upload will surface the real error).
- The bucket-provision cache is per-process (`customerInvoicesBucketChecked`). Cold-start workers repeat the check once.
- `signedUrlForCapturedDocument` default TTL is 1 hour — increase judiciously since signed URLs cannot be revoked. No public bucket path: direct GET returns 400.
- Captured-docs bucket content is originally scanned slips/PDFs; customer-invoices bucket is sealed PDF snapshots that are legally the sent invoice (PRD-06 evidence chain).

## Recent changes
- 2026-04-23: PRD-06 Phase 1 — added `uploadCustomerInvoicePdf` + `ensureCustomerInvoicesBucket` for invoice-as-evidence sealed snapshots.
- 2026-04-22: File introduced — capture module migrated from BYTEA columns to Supabase Storage pointers.
