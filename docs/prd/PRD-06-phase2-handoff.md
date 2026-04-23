# Handoff — PRD-06 Phase 2 (Customer Portal + Access Log)

**From session:** PRD-06 Phase 1 shipped (commit `6c63a2e`, deployed to `app.isaflow.co.za` 2026-04-23 09:40 SAST, /api/health 200).
**Target:** PRD-06 Phase 2 — Customer Portal + Access Log (2 weeks, P0).

---

## Current state (facts, verified)

- Migration `426_ar_invoice_evidence.sql` applied to prod and recorded in `schema_migrations`.
- `customer_invoices` has: `rendered_pdf_storage_path`, `rendered_pdf_sha256`, `rendered_pdf_rendered_at`, `source_document_id` (FK → `captured_documents.id` ON DELETE SET NULL) + `idx_cust_inv_source_doc` + `idx_cust_inv_rendered_pdf`.
- Supabase bucket `customer-invoices` created lazily on first snapshot via `ensureCustomerInvoicesBucket()` in `src/lib/supabaseStorage.ts`.
- Unit tests: **3137/3137 green** (+8 new: 5 snapshot service, 3 AR drill-through).
- `bunx tsc --noEmit` clean.
- Next migration number: **427**.

## What Phase 1 shipped

| File | Purpose |
|---|---|
| `scripts/migrations/sql/426_ar_invoice_evidence.sql` | Schema + FK + indexes |
| `src/modules/accounting/services/ar/invoicePdfSnapshotService.ts` | `snapshotInvoicePdf` (idempotent) + `getSealedInvoicePdf` |
| `src/lib/supabaseStorage.ts` | `CUSTOMER_INVOICES_BUCKET`, `uploadCustomerInvoicePdf`, `ensureCustomerInvoicesBucket` |
| `pages/api/accounting/ar/invoice/[id]/pdf.ts` | GET sealed PDF (falls back to render) + POST force-snapshot |
| `pages/api/accounting/customer-invoices-detail.ts` | `approve`/`send` now triggers snapshot non-blocking |
| `src/modules/accounting/services/core/evidenceGraphService.ts` | TB drill prefers AR snapshot; exposes `customerInvoiceId` + `sealedPdfUrl` |

## Phase 2 scope (from `docs/prd/PRD-06-ar-evidence-capture.md` §7.2)

- `portal_session` token model + `customer_invoice_views` table (§4.2 has full DDL).
- Materialised view `customer_invoice_view_summary` + nightly refresh cron.
- Public page `/portal/invoice/[token]` — view PDF, pay (placeholder), dispute.
- Tracking pixel endpoint `/ar/pixel/[invoiceId]/[token].gif`.
- `portalAccessService.ts`, `readReceiptService.ts` (new).
- "Last viewed" summary column on AR list UI.
- API: `GET /ar/invoice/[id]/views`, `GET /ar/invoice/[id]/portal-link`.

**Exit criteria:** bookkeeper sends an invoice; customer opens it via portal link; AR list shows "viewed N minutes ago" within 60s.

## Phase 2 first-cut build order

1. Migration 427 — `customer_invoice_views` table + 2 indexes + `customer_invoice_view_summary` MV (PRD §4.2).
2. `portalAccessService.ts` — HMAC-signed token mint (reuse `PORTAL_TOKEN_SECRET` env pattern from existing `src/modules/accounting/services/ar/portalService.ts`).
3. `GET /portal/invoice/[token]` public page — reuse sealed-PDF download via `getSealedInvoicePdf`; log view.
4. Tracking-pixel endpoint — 1×1 GIF, write `view_source='tracking_pixel'` row.
5. `GET /api/accounting/ar/invoice/[id]/views` — list view rows, company-scoped.
6. Add "last viewed" column to AR list (`pages/accounting/ar/...`) backed by the MV.
7. Cron `POST /api/cron/ar-matview-refresh` (X-Cron-Secret) — nightly `REFRESH MATERIALIZED VIEW CONCURRENTLY customer_invoice_view_summary`.

## Gotchas pulled from this session

- **`gl_journal_entries.source_document_id` is written as `invoiceId` today** (see `customerPaymentAllocationService.ts:176`). That's the customer_invoice UUID, not a `captured_documents.id` — it violates the FK added in mig 409 but apparently writes anyway in prod. Drill-through sidesteps this by joining `customer_invoices.gl_journal_entry_id = je.id` and reading `customer_invoices.source_document_id`. Do NOT rely on `je.source_document_id` for AR.
- **`captured_documents.document_type`** has no CHECK constraint — Phase 1 added `'sent_invoice'`; Phase 2 will need `'portal_view'`? probably not — views are a separate table. Stay off `captured_documents` for view logging.
- **`captured_documents.matched_invoice_id`** is semantically for AP (supplier_invoices). Leave null for AR snapshots.
- **Neon's pg driver returns `Date` for DATE columns.** Normalise with the `toISODate` pattern from `expenseClaimService.ts`.
- **`sql.transaction([...])`** batches inserts on the pooler — useful if you need a multi-statement write (e.g. mint token + first view row atomically).

## Verification cycle (copy-paste for Phase 2 exit)

```bash
cd /home/hein/Workspace/IsaFlow
bun run test:unit 2>&1 | tail -3          # should be >= 3137
bunx tsc --noEmit                          # clean
bunx playwright test prod-auth-refresh --config=playwright-prod.config.ts
bunx playwright test prd05-full-audit --config=playwright-prod.config.ts   # should still be 35/35
# Add tests/e2e/prd06-phase2-portal.spec.ts covering: portal link → PDF view → view row appears
```

## Deploy cycle (same as Phase 1)

```bash
bun run tsc --noEmit
git add -A && git commit -m "feat(prd-06 phase2): customer portal + access log"
rm -rf .next && bash scripts/deploy.sh
```

Business-hours gate (08:00–17:00 SAST Mon–Fri) applies to prod. Hein must approve each prod deploy.

## Open questions for Phase 2

1. Token TTL — PRD §9 recommends 14 days. Confirm with Hein before coding.
2. IP binding — first-view IP anchored, reject subsequent views from a different IP? Enforce-on-fraud-score or hard-reject?
3. Pay button — Phase 2 has a "placeholder". Which text / icon? Disable vs. "Coming soon"?

## Entry command for the next session

```
continue PRD-06 Phase 2 — customer portal + access log.
Start by reading docs/prd/PRD-06-phase2-handoff.md, then
docs/prd/PRD-06-ar-evidence-capture.md §4.2 + §7.2. Next migration number is 427.
```
