# K-066 — A supplier payment can be allocated to another supplier's bill

**Claim.** Allocation checks neither the supplier nor the bill status, so draft,
cancelled and foreign-supplier bills are settled.

**Corrected trigger.** `createSupplierPayment`
(supplierPaymentService.ts:139-147) loads the bills with
`WHERE id = ANY($ids::UUID[]) AND company_id = $company`. The predicate names
the company and the ids only — not `input.supplierId`, not `status`. The single
follow-up check is a row-count equality, and `validatePaymentAllocations` is
pure and sees only what that query returned. `processSupplierPayment` then
debits AP and moves `amount_paid` on whatever bill was named.

**Disposition: CONFIRMED.**

**Evidence.** Read with `git show origin/master:src/modules/accounting/services/ap/supplierPaymentService.ts`;
unchanged between 5661d6f0 and origin/master. RED test
`tests/integration/k066-supplier-payment-foreign-bill.int.test.ts` against real
PostgreSQL: **3 tests, 3 failed** — a payment raised against supplier A
successfully allocated supplier B's approved bill, and separate payments
successfully allocated a `draft` and a `cancelled` bill (see `red.log`, which
shows the created `SP-2026-000NN` payment rows the assertions expected to be
refused).

**Reachability.** `POST /api/accounting/supplier-payments`, plus
`batchPaymentService`, both of which pass user-supplied `supplierId` and
`allocations` straight through.

**Proposed fix.** In the bill-loading query at lines 139-144 add
`AND supplier_id = ${input.supplierId}::UUID` and
`AND status NOT IN ('draft', 'cancelled', 'pending_approval')`, then make the
row-count mismatch at line 145 name which bills were refused and why (a bare
"not found" would mislead on a cancelled bill). Mirror the same predicates in
`batchPaymentService`.

**Historical-data impact.** Existing payments may settle bills belonging to a
different supplier, or bills that were never approved. Read-only probe (NOT run):

```sql
SELECT sp.id, sp.payment_number, sp.supplier_id AS pay_supplier,
       si.id AS bill, si.supplier_id AS bill_supplier, si.status
FROM supplier_payments sp
JOIN payment_allocations pa ON pa.payment_id = sp.id
JOIN supplier_invoices si ON si.id = pa.invoice_id
WHERE si.supplier_id <> sp.supplier_id
   OR si.status IN ('draft', 'cancelled', 'pending_approval');
```

**Risks.** Tightening the status set could refuse a workflow that legitimately
pays a `pending_approval` bill; confirm the intended set against
`supplierInvoiceWorkflowService` before shipping.
