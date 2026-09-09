# K-065 — processSupplierPayment has an unguarded status flip

**Claim.** No row lock and no source-status predicate, so concurrent processing
double-applies the payment.

**Corrected trigger.** Two overlapping requests to process the SAME approved
payment. `processSupplierPayment` reads it with `getSupplierPaymentById`
(supplierPaymentWorkflowService.ts:56 — a plain SELECT, no `FOR UPDATE`),
checks `status !== 'approved'` at line 58, and flips the row at lines 108-114
with `WHERE id = ... AND company_id = ...` and no `status = 'approved'` arm.
Under READ COMMITTED the second reader cannot see the first's uncommitted
write and does not block on the row, so both post.

**Disposition: CONFIRMED.**

**Evidence.** Read with `git show origin/master:src/modules/accounting/services/ap/supplierPaymentWorkflowService.ts`;
the file is unchanged between 5661d6f0 and origin/master. RED test
`tests/integration/k065-supplier-payment-double-process.int.test.ts`, run
against the disposable real-PostgreSQL fixture: **1 test, 1 failed** — two
`auto_supplier_payment` journals for one payment (JE-2026-00001 and
JE-2026-00002 in `red.log`), the payable debited 230 instead of 115, and
`amount_paid` on the bill at 230. The interleave is sequenced, not raced: the
second call is issued only after the first has posted and is proven blocked on
a lock via `pg_stat_activity` before the first commits.

**Reachability.** `pages/api/accounting/supplier-payments/[id]/process.ts` and
the AP bulk actions; each request gets its own `withAuth` transaction, which is
what makes the two readers independent.

**Proposed fix.**
1. Add `lockSupplierPaymentForUpdate` (mirroring `lockSupplierInvoiceForUpdate`)
   and take it before the `getSupplierPaymentById` read.
2. Add `AND status = 'approved'` to the UPDATE at lines 108-114 and treat a
   zero-row result as "already processed" rather than reading `rows[0]!`.
3. Do the same for `approveSupplierPayment` (lines 28-33), which has the
   identical shape.

**Historical-data impact.** Any payment processed twice left two journals, the
payable debited twice and `amount_paid` overstated. Read-only probe (NOT run —
production is out of scope for this validator):

```sql
SELECT sp.id, sp.payment_number, count(je.id) AS journals
FROM supplier_payments sp
JOIN gl_journal_entries je ON je.company_id = sp.company_id
 AND je.description = 'Supplier payment ' || sp.payment_number
GROUP BY sp.id, sp.payment_number HAVING count(je.id) > 1;
```
Also compare `supplier_invoices.amount_paid` against
`SUM(payment_allocations.amount_allocated)` for processed payments.

**Risks.** Taking the lock changes the failure mode of the AP bulk action from
"both succeed" to "second waits then refuses"; K-014's fix set that precedent.
