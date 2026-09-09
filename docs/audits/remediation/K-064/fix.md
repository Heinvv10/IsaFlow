# K-064 fix — batch payment creation validates its lines before writing any

**Trigger.** `createBatch` looped the request body and INSERTed
`payment_allocations` rows straight from it. No statement read
`supplier_invoices`, and that table's only relevant constraint is an FK to
`supplier_invoices(id)` with no company predicate — so another tenant's bill,
another supplier's bill, an unapproved bill and an over-payment were all
accepted. The damage landed in `processBatch`: its journal debits Accounts
Payable for the batch's full total while its subledger UPDATE is company-scoped
and silently skips the foreign bill, so AP is debited with nothing relieved.

**Before / after.** `createBatch` now calls `assertBatchAllocatable` before it
opens its transaction. That runs every payment through
`planSupplierAllocationLines` — the gate the single-payment AP path already
uses, which enforces tenant, supplier, status and outstanding balance in one
company-scoped read — and then refuses a bill named by more than one payment of
the same batch. That last check is not decoration: the planner is given
`paymentId: null` because these payments do not exist yet, so it cannot see the
batch's own other lines, and two payments could otherwise each pass the balance
check against the same bill. Nothing is written when any line is refused.

**Files.** `src/modules/accounting/services/ap/batchPaymentService.ts` (255
lines, under the 300 limit).

**Tests.** Real PostgreSQL (disposable fixture):
- `tests/integration/k064-batch-payment-creation-unvalidated.int.test.ts` — 2 tests (validator's RED, now green): foreign tenant, over-payment.
- `tests/integration/k064-batch-payment-guarded.int.test.ts` — 3 tests: a different supplier inside the same tenant refused, one bill named by two payments refused, and a valid batch run through `approveBatch` + `processBatch` where the journal balances (DR 200 = CR 200) and the AP debit equals the `amount_paid` the two bills actually took.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** Read-only detection of both shapes (NOT run —
production is out of scope):

```sql
-- allocations against a bill in another tenant
SELECT sp.company_id, sp.id, sp.payment_number, pa.invoice_id
FROM payment_allocations pa
JOIN supplier_payments sp ON sp.id = pa.payment_id
JOIN supplier_invoices si ON si.id = pa.invoice_id
WHERE si.company_id <> sp.company_id;

-- bills settled past their own total
SELECT company_id, id, invoice_number, total_amount, amount_paid
FROM supplier_invoices
WHERE amount_paid > total_amount + 0.01;
```
Hits need correcting journals; the guard does not repair existing rows.

**Limits.** The gate is on creation. It does not count allocations sitting on
OTHER unprocessed batches or draft payments, so two separate batches can still
each claim a bill's full balance — the same gap the planner has generally, and
wider than this defect. `processBatch` itself is unchanged, and its inline
status CASE still bypasses `recomputeInvoiceStatus`. Routing through the shared
planner changes the error messages the UI will surface.
