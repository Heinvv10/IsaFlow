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

## Round 2 (2026-09-21) — reconciled with master 638 commits later

**What R-068 (`adbe783a1`) covers, and what it does not.** R-068 added
`assertSupplierInCompany(companyId, input.supplierId)` to `createSupplierPayment`:
it refuses a supplier id from ANOTHER company. It does not look at the bills. The
bill query on master still reads `id, invoice_number, total_amount, amount_paid,
balance` by company and id only, so a same-company other supplier's bill and a
draft / cancelled / pending_approval / disputed bill all pass.

**Still REAL on origin/master c19508a12**, measured through supplier-payments
POST: a payment to supplier A naming supplier A2's approved bill (same company)
answered **201** and wrote the payment and its allocation; so did a draft, a
cancelled, a pending_approval and a disputed bill (5 × 201, `round2-red-master.log`).
`processSupplierPayment` then debits AP and moves `amount_paid` on those bills
with no status check of its own. Company B's bill was already refused on master
(row-count check → 500, rolled back) — that part was never the defect.

**Merge.** `supplierPaymentService.ts` taken from master; R-068's
`assertSupplierInCompany` kept first, then the bill query selects `supplier_id`
and `status` and every row goes through `assertBillAllocatable` (now in
`billAllocatable.ts`, throwing `SupplierPaymentRefusal`). supplier-payments POST
answers that refusal **400** — it is raised before `withTransaction` opens, so
the COMMIT on a 4xx commits nothing; before this round it would have been a 500.

**R-068's own test relied on the defect.** Its "still stores company A's own
supplier" cases for supplier-payments and batch-payments POST allocated to the
seeded bill, which belongs to SUP_A2, on a payment to SUP_A. With this guard
they were refused, correctly. The fixture now seeds `BILL_A` owned by SUP_A and
those two cases use it; nothing else read the seeded bill. The old cases passed ONLY
because of K-066: they allocated a supplier-A payment to supplier A2's bill and
expected a write. The R-068 assertions themselves are unchanged — the foreign
(company B) supplier is still refused 400 with "was not found for this company"
and zero rows, and company A's own supplier still writes exactly one row; only the
bill id in those two request bodies changed (`ids.BILL` → `ids.BILL_A`).

**Tests.** The two round-1 service-level files are replaced by
`tests/integration/k066-supplier-payment-foreign-bill.int.test.ts` (route-level):
other-supplier bill, draft, cancelled, pending_approval, disputed → 400 with no
payment row and no allocation; company B's bill still refused with nothing
written; own approved bill → 201. Red on master 5/7, green 7/7.

**Mutation** (`K-063/round2-mutations.log`): removing the supplier comparison
(M2) turns the same-company cases red in K-066 and K-064; skipping the
`createSupplierPayment` loop (M3) turns all 5 K-066 refusal cases red. Both
restored byte-identical.

**Round 3** closed the process-time gap this round left open — see
`K-063/fix.md` "Round 3": a bill cancelled, disputed, sent back or reassigned
between creation and processing is now refused at process time, under the bill
lock, before any write, and the payment stays `approved`.
