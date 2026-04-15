# Phase 5 — Wave 3 Fix Log

**Date:** 2026-04-15
**Scope:** All BL-IDs fixed across Wave 1 (mop-up) and Wave 3 (fix loop)
**Total fixed:** 56 gate-blocking findings — 33 P0 + 23 P1

---

## Columns

| Column | Description |
|--------|-------------|
| BL-ID | Bug/finding identifier |
| Severity | P0 (gate-blocking critical) or P1 (gate-blocking high) |
| File | Primary file(s) changed |
| Commit SHA | Git commit that introduced the fix |
| Test file | Test that covers the fix |

---

## Wave 1 — Mop-up (pre-Wave 2 scan)

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-43 | P1 | `src/modules/accounting/services/sageMigrationService.ts` + 4 callers | `81f831c` | `tests/integration/api/sageMigrationService.test.ts` |
| BL-45 | P0 | `src/modules/accounting/services/creditNoteService.ts` (7 UPDATEs) | `1afc967` | `tests/integration/api/creditNoteServiceTenant.test.ts` |
| BL-46 | P0 | `src/modules/accounting/services/customerPaymentAllocationService.ts:147` | `62207a3` | `tests/integration/api/postCustomerInvoiceToGL.test.ts` |

---

## Wave 3 — Fix Loop (post-Wave 2 scan)

### Batch 1 — Tenant UPDATE guards

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-47 | P0 | `src/modules/accounting/services/supplierPaymentWorkflowService.ts` | `9c96a51` | `tests/integration/api/BL-47-supplier-payment-tenant.test.ts` |
| BL-48 | P0 | `src/modules/accounting/services/batchPaymentService.ts` | `9c96a51` | `tests/integration/api/BL-48-batch-payment-tenant.test.ts` |
| BL-49 | P0 | `src/modules/accounting/services/bankAllocationService.ts` | `9c96a51` | `tests/integration/api/BL-49-50-51-bank-allocation-tenant.test.ts` |
| BL-50 | P0 | `src/modules/accounting/services/bankAllocationService.ts` | `9c96a51` | `tests/integration/api/BL-49-50-51-bank-allocation-tenant.test.ts` |
| BL-51 | P0 | `src/modules/accounting/services/bankAllocationService.ts` | `9c96a51` | `tests/integration/api/BL-49-50-51-bank-allocation-tenant.test.ts` |
| BL-52 | P0 | `src/modules/accounting/services/bankRulesMatchingService.ts` | `9c96a51` | `tests/integration/api/BL-52-bank-rules-tenant.test.ts` |

### Batch 2 — Schema / NOT-NULL INSERT fixes

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-53 | P0 | Multiple INSERT sites — `company_id` / required columns populated | `4aefd8f` | `tests/integration/api/BL-53-57-insert-not-null-fixes.test.ts` |
| BL-54 | P0 | Multiple INSERT sites — `company_id` / required columns populated | `4aefd8f` | `tests/integration/api/BL-53-57-insert-not-null-fixes.test.ts` |
| BL-55 | P0 | Multiple INSERT sites — `company_id` / required columns populated | `4aefd8f` | `tests/integration/api/BL-53-57-insert-not-null-fixes.test.ts` |
| BL-56 | P0 | Multiple INSERT sites — `company_id` / required columns populated | `4aefd8f` | `tests/integration/api/BL-53-57-insert-not-null-fixes.test.ts` |
| BL-57 | P0 | Multiple INSERT sites — `company_id` / required columns populated | `4aefd8f` | `tests/integration/api/BL-53-57-insert-not-null-fixes.test.ts` |

### Batch 3 — CSRF wrap on money-moving routes

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-58 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(covered by existing BL-22 CSRF middleware tests; no new per-route tests added — 21 routes wrapped in single commit)_ |
| BL-59 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-60 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-61 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-62 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-63 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-64 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-65 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-66 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-67 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-68 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-69 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-70 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-71 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-72 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-73 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-74 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-75 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-76 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-77 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |
| BL-78 | P0 | `pages/api/accounting/` — money-moving route wrapped with `withCsrf` | `3da88cc` | _(see BL-58 note)_ |

### Batch 4 — Ghost migration DB row deletion

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-79 | P0 | DB — ghost `schema_migrations` row for `245_inventory.sql` deleted (Path 2) | `b296286` | `docs/audits/2026-04-15/phase5-BL-79-resolution.md` |

### Batch 5 — Soft-delete logging + bank_tx guards

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-80 | P1 | Soft-delete service — purge audit log now records `company_id` | `f704cf1` | `tests/unit/services/bl80-83-tenant-isolation.test.ts` |
| BL-81 | P1 | `src/modules/accounting/services/bankTransactionService.ts` — guard 1 | `f704cf1` | `tests/unit/services/bl80-83-tenant-isolation.test.ts` |
| BL-82 | P1 | `src/modules/accounting/services/bankTransactionService.ts` — guard 2 | `f704cf1` | `tests/unit/services/bl80-83-tenant-isolation.test.ts` |
| BL-83 | P1 | `src/modules/accounting/services/bankTransactionService.ts` — guard 3 | `f704cf1` | `tests/unit/services/bl80-83-tenant-isolation.test.ts` |

### Batch 6 — Group IDOR guards + entity ownership

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-84 | P1 | Eliminations service — `group_id` guard added | `384ce9e` | `tests/unit/services/bl84-86-group-idor.test.ts` |
| BL-85 | P1 | Intercompany match service — `group_id` guard added | `384ce9e` | `tests/unit/services/bl84-86-group-idor.test.ts` |
| BL-86 | P1 | Document upload handler — entity ownership verification added | `384ce9e` | `tests/unit/services/bl84-86-group-idor.test.ts` |

### Batch 7 — Zod validation on auth/invite handlers

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-87 | P1 | Auth/invite handler — Zod schema validation added | `03dd2ed` | _(no new tests; relies on existing auth integration + schema-level enforcement)_ |
| BL-88 | P1 | Auth/invite handler — Zod schema validation added | `03dd2ed` | _(see BL-87 note)_ |
| BL-89 | P1 | Auth/invite handler — Zod schema validation added | `03dd2ed` | _(see BL-87 note)_ |
| BL-90 | P1 | Auth/invite handler — Zod schema validation added | `03dd2ed` | _(see BL-87 note)_ |
| BL-91 | P1 | Auth/invite handler — Zod schema validation added | `03dd2ed` | _(see BL-87 note)_ |
| BL-92 | P1 | Auth/invite handler — Zod schema validation added | `03dd2ed` | _(see BL-87 note)_ |
| BL-93 | P1 | Auth/invite handler — Zod schema validation added | `03dd2ed` | _(see BL-87 note)_ |
| BL-94 | P1 | Auth/invite handler — Zod schema validation added | `03dd2ed` | _(see BL-87 note)_ |

### Batch 8 — Migration prefix renames + DB sync

| BL-ID | Severity | File | Commit SHA | Test file |
|-------|----------|------|------------|-----------|
| BL-95 | P1 | `scripts/migrations/sql/` — duplicate-prefix migration renamed | `3e801d7` | _(DB state verified in commit; 8 files renamed + schema_migrations synced)_ |
| BL-96 | P1 | `scripts/migrations/sql/` — duplicate-prefix migration renamed | `3e801d7` | _(see BL-95 note)_ |
| BL-97 | P1 | `scripts/migrations/sql/` — duplicate-prefix migration renamed | `3e801d7` | _(see BL-95 note)_ |
| BL-98 | P1 | `scripts/migrations/sql/` — duplicate-prefix migration renamed | `3e801d7` | _(see BL-95 note)_ |
| BL-99 | P1 | `scripts/migrations/sql/` — duplicate-prefix migration renamed | `3e801d7` | _(see BL-95 note)_ |
| BL-100 | P1 | `scripts/migrations/sql/` — duplicate-prefix migration renamed | `3e801d7` | _(see BL-95 note)_ |
| BL-101 | P1 | `scripts/migrations/sql/` — duplicate-prefix migration renamed | `3e801d7` | _(see BL-95 note)_ |
| BL-102 | P1 | `scripts/migrations/sql/` — duplicate-prefix migration renamed | `3e801d7` | _(see BL-95 note)_ |

---

## Summary counts

| Wave | P0 fixed | P1 fixed | Total |
|------|----------|----------|-------|
| Wave 1 (mop-up) | 2 | 1 | 3 |
| Wave 3 Batch 1 (tenant UPDATEs) | 6 | 0 | 6 |
| Wave 3 Batch 2 (NOT-NULL INSERTs) | 5 | 0 | 5 |
| Wave 3 Batch 3 (CSRF wrap) | 21 | 0 | 21 |
| Wave 3 Batch 4 (ghost migration) | 1 | 0 | 1 |
| Wave 3 Batch 5 (soft-delete + bank_tx) | 0 | 4 | 4 |
| Wave 3 Batch 6 (group IDOR) | 0 | 3 | 3 |
| Wave 3 Batch 7 (auth/invite Zod) | 0 | 8 | 8 |
| Wave 3 Batch 8 (migration renames) | 0 | 8 | 8 |
| **Total** | **35** | **24** | **56** (note: BL-43 Wave 1 is P1, not P0) |

> Note: The 56 gate-blocking count aligns with BL-43..BL-102 across both waves. Wave 1 also fixed BL-44/BL-41/BL-42 (pre-scan hardening) not counted in the 56.
