# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from api-error-handler.claude.md

## Recent changes
- 2026-04-24: Pentest M10–M23 batch hardened CORS and moved allow-list to `src/lib/cors.ts`.
- 2026-04-18: withAuth codemod — handler generic changed so `withCompany`/`withUserAuth` no longer need `as any` casts.
- 2026-04-15: BL-53 defensive isolation scope + sanitised route tag.

# Archived from apiResponse.claude.md

## Recent changes
- 2026-04-24: Pentest M10–M23 CORS dedupe; Critical+High batch added `badRequestFromError`; PAYG Phase 1 introduced `paymentRequired` and `ErrorCode.PAYMENT_REQUIRED`.

# Archived from apiResponse.types.claude.md

## Recent changes
- 2026-04-24: Split from apiResponse.ts during PAYG Phase 1; adds `PAYMENT_REQUIRED` code.

# Archived from cors.claude.md

## Recent changes
- 2026-04-24: Created as part of pentest batch M10–M23 to deduplicate CORS allow-lists.

# Archived from csv.claude.md

## Recent changes
- 2026-04-04: Introduced as part of pentest remediation batch (42 findings across 8 attack dimensions).

# Archived from csvExport.claude.md

## Recent changes
- 2026-04-19: Added during PRD-01 Phase 5A (practice users directory, CSV export, Kanban DnD).

# Archived from documentStorage.claude.md

## Recent changes
- 2026-04-22: Created as the Phase 1 deferral closeout (commit d043a22), then swapped from BYTEA to Supabase Storage (commit d55b296).
- 2026-10-22: new callers.
  - `document-capture` POST calls `storeCapturedBytes` (the upload is stored before the answer); the capture read job calls `fetchRawBytes` to read it back.
  - `RawBytes.storedHash` is the `raw_bytes_sha256` column (null when unset); `hash` is fabricated from the bytes when the column is null, so verify against `storedHash`.
  - `downloadCapturedDocument` throws `supabaseStorage.CapturedDocumentMissingError` only for a 404 "Object not found" (not retryable); every other failure is a plain Error (retryable). `fetchRawBytes` still returns null when no pointer is set.

# Archived from email-templates-auth.claude.md

## Recent changes
- 2026-03-30: Added with the initial user management, onboarding, and email system rollout.

# Archived from email-templates-budget-digest.claude.md

## Recent changes
- 2026-11-03: added (budgets P5-4).

# Archived from email-templates-invite.claude.md

## Recent changes
- 2026-04-12: Split from email-templates.ts during the ≤300-line refactor.

# Archived from email-templates-invoice.claude.md

## Recent changes
- 2026-04-12: Split from email-templates.ts during the ≤300-line refactor.

# Archived from email-templates-practice-digest.claude.md

## Recent changes
- 2026-04-19: Added during PRD-01 Phase 5B cron automation rollout (PR #27).

# Archived from email-templates-practice-monthly.claude.md

## Recent changes
- 2026-04-19: Added during PRD-01 Phase 5B cron automation rollout (PR #27).

# Archived from email-templates-shared.claude.md

## Recent changes
- 2026-10-22: Added `emailContentRow`; register, contact, password reset, management pack and 4 portal emails now render inside the card (S-04/S-08 follow-up D).
- 2026-04-24: Hardened signature sanitisation during pentest Critical+High batch.
- 2026-04-13: Switched logo to inline CID with dark-bg-safe variant.
- 2026-04-12: Split from email-templates.ts for the ≤300-line refactor.

# Archived from email-templates.claude.md

## Recent changes
- 2026-04-12: Introduced when email-templates.ts was split into shared/invite/invoice files.

# Archived from encryption.claude.md

## Recent changes
- 2026-04-24: Pentest M1+M6+M14+M15+M20+M21+L4 batch — `decryptToken` now rethrows on tag mismatch.
- 2026-04-04: PBKDF2 key derivation introduced; legacy raw key kept as decrypt-fallback.

# Archived from keyboard-shortcuts.claude.md

## Recent changes
- 2026-03-30: Added during the Marneweck roadmap rollout (22 features across 8 workstreams).

# Archived from neon.claude.md

## Recent changes
- 2026-11-11 (migration 977): `portal_access` gets FORCE RLS with the active-company tenant_isolation policy; app_service keeps its select and delete mirrors, so the service pool's portal session check is unchanged.
- 2026-10-24 (S-07d, migration 937): app roles lose UPDATE and DELETE on `company_users`, INSERT/UPDATE on `portal_contacts`, `share_links`, `audit_portal_sessions`, `capture_whatsapp_claims`, `capture_inboxes` and `bank_feed_connections` (use stamps granted back), every privilege on `portal_magic_links`, and `portal_access.password_hash` and its writes; the writes run on `migrationAdminPool()`. Checked on every deploy by `app_pool_reach_violations()`, which gains an unreadable-column clause.
- 2026-10-23 (S-07c, migration 930): app_user (so both logins) loses INSERT/UPDATE on the credential and membership tables and every grant on the reset tokens and the impersonation stash; the writes move to `migrationAdminPool()`. `waitlist_signups` gets RLS, INSERT only. `refresh_customer_invoice_view_summary_if_due()` refreshes at most once per 10 minutes, and only migration_admin may call it or its old name.
- 2026-10-23 (S-07b follow-ups): app_service loses `UPDATE (email, updated_at)` on users and every grant on `auth_email_verification_tokens` (918); the AR matview becomes `customer_invoice_view_summary_mv`, unreadable by app roles, behind a company-filtered view under the old name (919); both rules run on every deploy (920).
- 2026-10-22 (S-07b): the pool logs in from `SERVICE_DATABASE_URL` (falls back to `DATABASE_URL`).
- 2026-10-03 (R-184): split the 475-line `neon.ts` into a barrel over `src/lib/neon/{pool,query,sql,transaction}.ts`. Declarations moved byte-identical; same export names and types (`docs/audits/remediation/R-184/`).
- 2026-10-02 (R-182): `PG_POOL_MAX` is read through `poolSizeFromEnv` with a floor of 2 (`MIN_PG_POOL_MAX`): outside a request `withTransaction` holds one connection and a bare `sql` in its callback takes a second, so a pool of 1 timed out. A refused spelling gives the size it meant, never more than 10.
- 2026-04-24: Supabase-cutover drift fixes; duplicate-prefix/ghost-row tracking hardening.
- 2026-04-18: ALS-aware routing — bare `sql` inside `withAuth` now uses the request tx client so RLS GUCs are honoured; pg.Pool driver replaced Neon serverless.

# Archived from pdf-to-image.claude.md

## Recent changes
- 2026-04-24: Added `pdfToImages` multi-page variant for CIPC COR39 director extraction.
- 2026-04-10: VLM service refactor adopted this module.

# Archived from supabaseStorage.claude.md

## Recent changes
- 2026-10-25: S-07e part B — `removeCapturedDocument` takes the company and refuses a pointer outside its prefix; `getStorageClient` no longer exported; a refusal logs the path cut to 200 characters.
- 2026-04-23: PRD-06 Phase 1 — added `uploadCustomerInvoicePdf` + `ensureCustomerInvoicesBucket` for invoice-as-evidence sealed snapshots.
- 2026-04-22: File introduced — capture module migrated from BYTEA columns to Supabase Storage pointers.

# Archived from validateEnv.claude.md

## Recent changes
- **Pool logins (S-07b)**: refuses `DATABASE_URL` on `isaflow_app` without `SERVICE_DATABASE_URL`, `DATABASE_URL` on `isaflow_service`, `SERVICE_DATABASE_URL` on `isaflow_app`, and, once `DATABASE_URL` is `isaflow_app`, a service login other than `isaflow_service`. The role is read from the pooler's `<role>.<tenant>` user too. In production, a request pool not on `isaflow_app` is reported to stderr on every boot, and `MIGRATION_ADMIN_DATABASE_URL` is required.
- 2026-10-22: S-07b added `SERVICE_DATABASE_URL` to the same-database check, and the pool-login rules.
- 2026-04-24: PR-4 separated `IMPERSONATION_JWT_SECRET` from `JWT_SECRET` (pentest L1); L-tier cleanup added `PLATFORM_ADMIN_DATABASE_URL` (L5) and `PORTAL_JWT_SECRET` (L3).
