# K-064 — batch payment creation validates nothing

**Claim.** `batchPaymentService.ts:78` rejects neither over-payment nor
foreign-tenant bills when a batch is created.

**Corrected trigger.** Accurate and wider than stated. `createBatch` (lines
78-98) loops the request body and INSERTs `payment_allocations` directly; no
statement in the function reads `supplier_invoices`, so tenant, supplier, status
and outstanding balance are all unchecked. The table's only relevant constraint
is `invoice_id -> supplier_invoices(id)`, with no company predicate, so any real
bill id is accepted.

The damage lands in `processBatch`: its journal debits Accounts Payable for the
batch's full total (line 136) while the subledger UPDATE is company-scoped
(line 171) and silently skips the foreign bill. AP is debited with nothing
relieved. An over-allocation is posted in full and drives `amount_paid` past
`total_amount`, and the inline CASE at lines 167-170 then marks the bill `paid`.

**Disposition: confirmed.**

**Evidence.**
- File unchanged between `5661d6f0` and `origin/master`; constraints read from
  the fixture schema. Reachable at `pages/api/accounting/batch-payments.ts:39`,
  which passes `req.body` straight in.
- RED test: `tests/integration/k064-batch-payment-creation-unvalidated.int.test.ts`.
  Two companies, one bill each at R100. Test 1 batches company A against
  company B's bill; test 2 batches R500 against a R100 bill. Both expected a
  rejection and zero allocation rows; both batches were created, the second with
  `totalAmount: 500`. 2 tests, 2 failed. Output: `red.log`.

**Proposed minimal fix.** Replace the raw loop with the AP gate that already
exists: `planSupplierAllocationLines(companyId, allocations, {paymentId: null,
supplierId: p.supplierId})` per payment. It enforces tenant, supplier, status
and outstanding balance and returns the lines to insert.

**Historical-data impact.** Read-only detection of both shapes:

```sql
-- foreign-tenant lines
SELECT sp.company_id, sp.id, pa.invoice_id
FROM payment_allocations pa
JOIN supplier_payments sp ON sp.id = pa.payment_id
JOIN supplier_invoices si ON si.id = pa.invoice_id
WHERE si.company_id <> sp.company_id;
-- over-settled bills
SELECT company_id, id, invoice_number, total_amount, amount_paid
FROM supplier_invoices WHERE amount_paid > total_amount + 0.01;
```
Not run — production is out of scope. Hits need correcting journals.

**Risks.** Routing `createBatch` through the shared planner changes its error
messages and will reject batches the UI currently accepts.
