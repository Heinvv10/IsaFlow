# Phase 5 — Wave 2 Stream 2A: Tenant Isolation Sweep

**Date:** 2026-04-15
**Stream:** 2A — Tenant isolation
**Method:** grep every UPDATE/DELETE/INSERT/driving-SELECT on multi-tenant tables, check company_id guard

## Summary

- Statements audited: ~180 (UPDATE: ~95, DELETE: ~15, INSERT: ~70 sampled)
- P0: 6
- P1: 5
- P2: 4
- P3: 1

## Findings

| # | File:line | Kind | Table | Guard | Severity | Evidence | Proposed fix |
|---|-----------|------|-------|-------|----------|----------|--------------|
| 1 | `src/modules/accounting/services/ap/supplierPaymentWorkflowService.ts:85-96` | UPDATE | `supplier_invoices` | **missing** | **P0** | `UPDATE supplier_invoices SET amount_paid = amount_paid + ${alloc.amountAllocated} WHERE id = ${alloc.invoiceId}` (no company_id) and `UPDATE supplier_invoices SET status = CASE ... WHERE id = ${alloc.invoiceId}` (no company_id) — both within `processSupplierPayment`. The payment is scoped to companyId (fetched via `getSupplierPaymentById(companyId, id)`) but the allocation IDs come from `payment.allocations` which were fetched in a prior SELECT. No company_id guard on the UPDATEs themselves. | Add `AND company_id = ${companyId}::UUID` to both UPDATE WHERE clauses |
| 2 | `src/modules/accounting/services/ap/batchPaymentService.ts:161-168` | UPDATE | `supplier_invoices` | **missing** | **P0** | Inside `processBatch()`: `UPDATE supplier_invoices SET amount_paid = ... WHERE id = ${p.invoice_id}::UUID` — allocation rows fetched from `payment_allocations` via `WHERE sp.batch_id = ${id}::UUID` with no company_id join/filter on the invoice UPDATE itself. Cross-tenant write is possible if an attacker crafts a batch referencing another tenant's invoice IDs. | Add `AND company_id = ${companyId}::UUID` to the supplier_invoices UPDATE |
| 3 | `src/modules/accounting/services/bank/bankAllocationService.ts:193-198` | UPDATE | `bank_transactions` | **missing** | **P0** | In `allocateTransaction()`: `UPDATE bank_transactions SET status = 'allocated' ... WHERE id = ${bankTxId}::UUID` — no company_id guard. The initial `SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID` at line 79 also lacks company_id, so there is no compensating control. Any authenticated tenant can allocate another tenant's bank transaction. | Add `AND company_id = ${companyId}::UUID` to both the initial SELECT (line 79) and the UPDATE (line 198) |
| 4 | `src/modules/accounting/services/bank/bankAllocationService.ts:291-294` | UPDATE | `bank_transactions` | **missing** | **P0** | In `splitAllocateTransaction()`: `UPDATE bank_transactions SET status = 'allocated' ... WHERE id = ${bankTxId}::UUID` — same pattern as finding #3; initial fetch at line 225 also unguarded. | Add `AND company_id = ${companyId}::UUID` to both the SELECT (line 225) and the UPDATE (line 292) |
| 5 | `src/modules/accounting/services/bank/bankAllocationService.ts:334-344` | UPDATE | `bank_transactions` | **missing** | **P0** | In `reverseReconciledTransaction()`: `UPDATE bank_transactions SET status = 'imported' ... WHERE id = ${bankTxId}::UUID` — no company_id guard. Initial fetch at line 308 also unguarded. GL reversal already checks companyId on the journal side but the bank_transactions reset is unscoped. | Add `AND company_id = ${companyId}::UUID` to both the SELECT (line 308) and the reset UPDATE (line 339) |
| 6 | `src/modules/accounting/services/bank/bankRulesMatchingService.ts:230-236` | UPDATE | `bank_transactions` | **missing** | **P0** | In `applyRules()` auto-create-JE loop: `UPDATE bank_transactions SET status = 'allocated' ... WHERE id = ${tx.id}::UUID` — the source `tx` rows are fetched by `bank_account_id` only (lines 140-168), with no company_id on those SELECTs either. The outer `bankAccountId` is validated against `company_id` at line 42, but the UPDATEs on individual rows omit the guard. | Add `AND company_id = ${companyId}::UUID` to the UPDATE (line 235) and add company_id to the matching SELECTs |
| 7 | `src/modules/accounting/services/core/softDeleteService.ts:254-259` | DELETE | `customer_invoices`, `supplier_invoices`, `customers`, `suppliers`, `bank_rules` | **missing** | **P1** | `purgeExpiredDeletes()` DELETEs rows across all soft-deletable tables by `deleted_at` timestamp only — no `company_id` filter. This is a background janitor job that purges all companies' soft-deleted rows. While this is intentional global cleanup, a mis-fired soft-delete on the wrong tenant's record would be silently purged without any tenant attribution. | Add `AND company_id = ANY(SELECT id FROM companies)` (or keep global-purge but add logging/alerting per company_id on deleted rows) |
| 8 | `src/modules/accounting/services/bank/bankTransactionQueryService.ts:127-131` | SELECT (driving read) | `bank_transactions` | **missing** | **P1** | `getBankTransactions()` when `filters.reconciliationId` is set: `SELECT ... WHERE bt.reconciliation_id = ${filters.reconciliationId}::UUID` — no company_id filter. The reconciliationId is user-supplied, so an attacker can read another tenant's bank transactions by guessing a valid reconciliation UUID. | Add `AND bt.company_id = ${companyId}` |
| 9 | `src/modules/accounting/services/bank/bankReconciliationService.ts:92-94` | UPDATE | `bank_transactions` | **missing** | **P1** | In `startReconciliation()`: `UPDATE bank_transactions SET reconciliation_id = ... WHERE bank_account_id = ${bankAccountId}::UUID AND status = 'imported' AND reconciliation_id IS NULL` — no company_id guard on the UPDATE. The bankAccountId is validated against companyId at line 42, providing a partial compensating control, but the UPDATE itself could stamp another company's orphaned transactions if they share a bank_account_id reference (UUID collision is negligible risk, but guard is still absent). | Add `AND company_id = ${companyId}::UUID` to the UPDATE |
| 10 | `src/modules/accounting/services/bank/bankReconciliationService.ts:122-123` | UPDATE | `bank_transactions` | **missing** | **P1** | In `completeReconciliation()`: `UPDATE bank_transactions SET status = 'reconciled' WHERE reconciliation_id = ${id}::UUID AND status = 'matched'` — no company_id guard. The reconciliation header is verified via `getReconciliationById(companyId, id)` (compensating control), but the UPDATE itself is unscoped. If `getReconciliationById` returns null and throws, the UPDATE never fires; but defensive-in-depth requires the guard. | Add `AND company_id = ${companyId}::UUID` to the UPDATE |
| 11 | `src/modules/accounting/services/bank/bankAllocationService.ts:79,107,123,138` | SELECT | `bank_transactions`, `suppliers`, `customers`, `gl_accounts` | **missing** | **P2** | Multiple unscoped SELECTs in `allocateTransaction()`: `SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID` (line 79), `SELECT name FROM suppliers WHERE id = ${entityId}::UUID` (line 107), `SELECT name FROM customers WHERE id = ${entityId}::UUID` (line 123), `SELECT ... FROM gl_accounts WHERE id = ${contraAccountId}::UUID` (line 138). These are read-only lookups used for display purposes; the companyId is passed to downstream writes, but the reads themselves leak data across tenants. Severity is P2 because these reads only expose names, not financial data. | Add `AND company_id = ${companyId}::UUID` to each SELECT |
| 12 | `src/modules/accounting/services/core/smartCategorizationService.ts:89-93` | SELECT (driving write) | `bank_transactions` | **missing** | **P2** | `bulkCategorize()` fetches transactions `WHERE id = ANY(${transactionIds}::UUID[])` without a company_id filter (line 91-93). The write at line 174-183 also lacks company_id. An attacker who knows another tenant's bank_transaction UUIDs can categorize those rows. | Add `AND company_id = ${companyId}::UUID` to both the SELECT (line 91) and each UPDATE (line 174) |
| 13 | `src/modules/accounting/services/core/smartCategorizationService.ts:174-183` | UPDATE | `bank_transactions` | **missing** | **P2** | Continuation of finding #12: the bulk UPDATE `WHERE id = ${txId}::UUID AND suggested_gl_account_id IS NULL` has no company_id guard. | Add `AND company_id = ${companyId}::UUID` |
| 14 | `pages/api/accounting/supplier-allocations.ts:135-137` | INSERT | `supplier_payment_allocations` | no company_id column | **P3** | `INSERT INTO supplier_payment_allocations (payment_id, invoice_id, amount_allocated)` — table apparently has no `company_id` column. The payment and invoice are both validated against companyId before the INSERT (lines 95-126), so the allocation itself is tenant-safe via FK. However, if the table gains direct-access queries in future without the JOIN validation, it would be unguarded. | Consider adding `company_id` column to `supplier_payment_allocations` for defence-in-depth; low urgency given current FK-validated flow |

## Clean statements (sampled, for traceability)

1. **`customer-merge.ts:54-57`** — `UPDATE customer_invoices SET customer_id = ${target_id} WHERE customer_id = ${source_id} AND company_id = ${companyId}` — both source and target are validated in a prior scoped SELECT; UPDATE includes company_id guard. Clean.

2. **`softDeleteService.ts:69-72`** — `UPDATE customers SET deleted_at = NOW() WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL` — correctly scoped per-entity soft-delete. Clean.

3. **`supplierInvoiceWorkflowService.ts:78-82`** — `UPDATE supplier_invoices SET status = 'approved' ... WHERE id = ${id} AND company_id = ${companyId}::UUID` — company_id guarded. Clean.

4. **`bankTransactionQueryService.ts:218-226`** — `matchTransaction()` UPDATE includes `AND company_id = ${companyId}::UUID`. Clean.

5. **`bankTransactionQueryService.ts:257-259`** — `excludeTransaction()` UPDATE includes `AND company_id = ${companyId}::UUID`. Clean.

6. **`bankTransactionQueryService.ts:273-276`** — `deleteTransactions()` DELETE includes `AND company_id = ${companyId}::UUID`. Clean.

7. **`creditNoteService.ts:171-173`** — `UPDATE customer_invoices SET amount_paid = ... WHERE id = ${cn.customer_invoice_id}::UUID AND company_id = ${companyId}::UUID`. Clean (note: BL-45 fixes applied).

8. **`duplicateMergeService.ts:51-56`** — customer merge UPDATEs all include `AND company_id = ${companyId}::UUID` and are pre-validated by a scoped SELECT. Clean.

9. **`archiveExecutionService.ts:143-180`** — All DELETEs include `WHERE company_id = ${companyId}` and are preceded by matching INSERTs scoped to the same companyId. Clean.

10. **`sageMigrationCompareService.ts:78-84`** — All four UPDATEs include `WHERE company_id = ${companyId}::UUID`. Clean.

## Notes

### Finding #1 & #2 — Supplier invoice UPDATEs in payment processing
These are P0 because the attacker pathway is: (1) create a legitimate batch/payment for their own company, (2) craft the allocation payload referencing another tenant's `invoice_id` UUIDs, (3) call the process endpoint. The allocation fetch in `processBatch` (`JOIN payment_allocations pa ON pa.payment_id = sp.id WHERE sp.batch_id = ${id}::UUID`) does restrict to the batch's payment IDs, but `payment_allocations` itself has no `company_id` column (see Finding #14), so a poisoned `payment_allocations` row could cascade to an unscoped invoice UPDATE.

### Findings #3, #4, #5 — bankAllocationService unscoped bank_transactions
All three `allocateTransaction`, `splitAllocateTransaction`, and `reverseReconciledTransaction` functions read and write `bank_transactions` by UUID alone. The API handler (`bank-transactions-action.ts`) passes `companyId` but the service ignores it for both the initial SELECT and the UPDATE. This is a clean cross-tenant write path for any authenticated user who obtains a valid bank transaction UUID.

### Finding #6 — bankRulesMatchingService auto-create loop
The initial transaction SELECTs filter by `bank_account_id` which is itself validated against `company_id` (line 42). However, the UPDATE that stamps the matched status omits the guard. Risk is lower (requires valid bankAccountId) but still P0 because the UPDATE on `bank_transactions` modifies financial state.

### Finding #8 — Reconciliation-scoped getBankTransactions
When `reconciliationId` is the only filter, the query returns all bank transactions linked to that reconciliation — across any tenant that possesses the UUID. The UUID is not secret (it can be obtained by listing reconciliations or brute force). This is a data read IDOR on financial records.

### Skipped per known-fixes
- BL-45 (creditNoteService.ts UPDATE sites): skipped — confirmed fixed in commit `1afc967`.
- BL-46 (postCustomerInvoiceToGL SELECT): skipped — confirmed fixed in commit `62207a3`.
- BL-43 (startRun INSERT): skipped — confirmed fixed in commit `81f831c`.
- BL-40/41/42/44 (sageImportService, sageCustomerImportService, customerPaymentAllocationService UPDATEs, createCreditNote INSERT): skipped — confirmed fixed per prior commits.

### `payment_allocations` vs `supplier_payment_allocations`
`batchPaymentService.ts` uses `payment_allocations` (not `supplier_payment_allocations`) as the join table. This table has no `company_id` column, making Finding #2 particularly acute — the company boundary relies entirely on the upstream `batch_id` scoping to a companyId-validated batch.
