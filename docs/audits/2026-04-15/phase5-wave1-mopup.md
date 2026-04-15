# Phase 5 — Wave 1 Mop-up Summary

**Date:** 2026-04-15
**Status:** Complete — Wave 1 checkpoint signed

## Fixes shipped

| BL-ID | Severity | File | Fix commit | Integration test |
|-------|----------|------|------------|------------------|
| BL-43 | P1 | `sageMigrationService.ts:52-59` (startRun signature) + 4 call sites | `81f831c` | `tests/integration/api/sageMigrationService.test.ts` (3 properties) |
| BL-45 | P0 | `creditNoteService.ts:168-248` (7 UPDATE sites in approve/cancel) | `1afc967` | `tests/integration/api/creditNoteServiceTenant.test.ts` (6 properties A–F) |
| BL-46 | P0 | `customerPaymentAllocationService.ts:147` (SELECT guard) | `62207a3` | `tests/integration/api/postCustomerInvoiceToGL.test.ts` (3 properties) |

## Summary of changes

### BL-43 — gl_migration_runs company_id (P1)
`startRun` now accepts `companyId` as a required 3rd arg and persists it on insert.
`getMigrationStatus` filters `gl_migration_runs` by `company_id`, so pre-fix every run
created since migration 288 was invisible to its owning tenant. 4 callers updated:
`sageImportService.ts:25`, `sageImportService.ts:155`, `sageCustomerImportService.ts:20`,
`sageMigrationService.ts:202` (autoMapAccounts).

### BL-45 — creditNoteService UPDATEs (P0)
7 UPDATE sites inside `approveCreditNote` and `cancelCreditNote` now carry
`AND company_id = ${companyId}::UUID`. Previously a caller operating on a
same-tenant credit note whose `customer_invoice_id` pointed to another tenant's
invoice could have mutated that invoice's `amount_paid`/`status`.

### BL-46 — postCustomerInvoiceToGL SELECT (P0)
The SELECT that feeds the GL-posting journal entry now carries
`AND ci.company_id = ${companyId}::UUID`. Previously a caller could pass another
tenant's invoice ID and auto-post it to their own GL, corrupting both tenants' books.

## Gate results

- `bunx tsc --noEmit` — clean, 0 errors
- `bun run test:unit` — 1903 passed (84 files)
- Phase 5 integration subset (6 files) — 22/22 passed
- Broader integration suite — 3 HTTP-dependent files fail with ECONNREFUSED on port 3200 (pre-existing condition requiring the dev server; not introduced by Wave 1). DB-direct integration tests all pass.

## Review trail

Each fix went through implementer → spec reviewer → code quality reviewer (two-stage).
All three fixes approved. BL-45 received one follow-up (test-company cleanup in `afterAll`)
amended into commit `1afc967`.

## Exit

Wave 1 checkpoint signed. Proceeding to Wave 2 (6 parallel read-only verification sweeps).
