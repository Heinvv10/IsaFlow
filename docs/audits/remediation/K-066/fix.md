# K-066 fix — createSupplierPayment checks whose bill it is and what state it is in

**Trigger.** `createSupplierPayment` loaded the bills it was about to allocate
with `WHERE id = ANY(...) AND company_id = ...`. The predicate named the company
and the ids only — not `input.supplierId`, not `status` — and the only follow-up
was a row-count equality. `validatePaymentAllocations` is pure and sees just
those rows. So a payment raised against supplier A settled supplier B's bill,
and a draft, cancelled, pending_approval or disputed bill was settled as readily
as an approved one; `processSupplierPayment` then debited AP against it.

**Before / after.** The query now also selects `supplier_id` and `status`, and
every returned row goes through `assertBillAllocatable` (K-063's shared check:
status must be balance-derived, supplier must be the payment's). Refusals are
raised in code rather than added to the WHERE clause deliberately, so the
message can say which bill and why — a bare "not found" would mislead on a
cancelled bill. A bill in another tenant still reads as "not found or belong to
a different company", which is correct: it must not be distinguishable from one
that does not exist.

**Files.** `src/modules/accounting/services/ap/supplierPaymentService.ts` (270
lines, under the 300 limit).

**Tests.** Real PostgreSQL (disposable fixture):
- `tests/integration/k066-supplier-payment-foreign-bill.int.test.ts` — 3 tests (validator's RED, now green): foreign supplier, draft, cancelled.
- `tests/integration/k066-supplier-payment-guard-cases.int.test.ts` — 3 tests: `pending_approval` refused, another tenant's bill refused as not found, and a valid payment still created with its allocations accounting for the whole payment total.
- `tests/unit/services/supplierPaymentService.test.ts` — the mocked bill row in "proceeds when all invoices belong to the correct company" gained `supplier_id` and `status`; without them the new check refused it. 8 tests in that file pass.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** Payments may already settle a bill of a different
supplier, or one that never credited AP. Read-only detection (NOT run —
production is out of scope):

```sql
SELECT sp.company_id, sp.id, sp.payment_number, sp.supplier_id AS pay_supplier,
       si.id AS bill, si.supplier_id AS bill_supplier, si.status
FROM supplier_payments sp
JOIN payment_allocations pa ON pa.payment_id = sp.id
JOIN supplier_invoices si ON si.id = pa.invoice_id
WHERE si.supplier_id <> sp.supplier_id
   OR si.status IN ('draft', 'cancelled', 'pending_approval', 'disputed');
```

**Limits.** The check runs on creation only; allocations written before this
commit are untouched. `createSupplierPayment` keeps its own bill query rather
than moving to `planSupplierAllocationLines`, because it additionally counts
unprocessed payments' pending allocations (the W3-AP over-payment guard), which
the shared planner does not.
