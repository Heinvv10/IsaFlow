# supabaseStorage.ts

## Purpose
Singleton `StorageClient` (from `@supabase/storage-js`) pointed at the IsaFlow self-hosted Supabase Kong (`$SUPABASE_URL/storage/v1`) with service-role auth. Provides typed upload / download / remove / signed-URL helpers for the `captured-documents` and `customer-invoices` buckets.

## Key exports
- `getStorageClient(): StorageClient` — cached instance, fails loudly when `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` env vars are missing.
- `CAPTURED_DOCS_BUCKET` — env-overridable constant (`'captured-documents'` default).
- `CUSTOMER_INVOICES_BUCKET` — env-overridable constant (`'customer-invoices'` default).
- `uploadCapturedDocument(companyId, documentId, buffer, contentType): Promise<UploadResult>` — path `<companyId>/<documentId>`, `upsert: false`.
- `uploadCustomerInvoicePdf(companyId, documentId, buffer): Promise<UploadResult>` — path `<companyId>/<documentId>.pdf`, content-type `application/pdf`. Lazily provisions the bucket (first call per process hits `createBucket`; idempotent via "already exists" error swallow).
- `ensureCustomerInvoicesBucket(): Promise<void>` — call-once bucket provisioner, cached via module-level `customerInvoicesBucketChecked` boolean.
- `downloadCapturedDocument(bucket, path): Promise<Buffer>` — generic download by bucket+path (works for either bucket despite the name).
- `removeCapturedDocument(bucket, path): Promise<void>` — best-effort; log-warn on failure.
- `signedUrlForCapturedDocument(bucket, path, expiresInSeconds=3600): Promise<string>` — short-lived signed URL for UI preview without proxying bytes.

## Dependencies
- `@supabase/storage-js@^2` — installed 2026-04-22.
- `./logger` — warn/error log.

## Critical notes
- **Server-only.** Uses `SUPABASE_SERVICE_ROLE_KEY`. Never import in client components.
- **Captured-docs bucket must exist on the target stack.** Dev stack was bootstrapped 2026-04-22 (private, 10MB cap, mime-whitelisted PDF/JPEG/PNG/WebP/TIFF). Production needs the same manual POST `/storage/v1/bucket` step before first upload — see `scripts/README-expectations-cron.md` and the prod deploy checklist.
- **Customer-invoices bucket is lazy-provisioned** — first call to `uploadCustomerInvoicePdf` creates it automatically via `ensureCustomerInvoicesBucket`. No manual bootstrap needed.
- **Generic `uploadToBucket` helper is private** — the two public upload functions thread tenant-scoped paths (`<companyId>/<documentId>[.pdf]`). Keep the pattern so bucket-level listings stay tenant-scoped.
- **No public path.** Direct GET returns 400; use `signedUrlForCapturedDocument` with a short expiry or `downloadCapturedDocument` server-side.

## Recent changes
- 2026-04-22: Created as the Phase 1 Storage wiring (commit d55b296).
- 2026-04-22: Added customer-invoices bucket + lazy provisioner + `uploadCustomerInvoicePdf` (sealed customer invoice PDF snapshots).
