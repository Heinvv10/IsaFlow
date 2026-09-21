# K-063 fix — the AP allocation status gate is now an allow-list

**Trigger.** `supplierAllocationLines.ts` blocked `cancelled` and `draft` only.
`supplier_invoices_status_check` also permits `pending_approval` and `disputed`,
and AP is credited only by `approveSupplierInvoice`, so a bill in either status
has no journal at all. It passed the gate and took the payment; the payment's
DR Accounts Payable had no matching credit, and `recomputeInvoiceStatus` left
the status alone (it restricts itself to `BALANCE_DERIVED`), so the bill read
unapproved and fully paid at once.

**Before / after.** Before: any status outside {cancelled, draft} could take a
payment. After: only the five `BALANCE_DERIVED` statuses can — the same set
`recomputeInvoiceStatus` will act on afterwards. A status added to the CHECK
constraint later now fails closed instead of silently joining the allowed set.
The refusal names the status: `Invoice X is pending_approval and cannot receive
a payment.` The supplier and status checks were factored into an exported
`assertBillAllocatable` so `createSupplierPayment` (K-066) refuses on the same
terms; ordering of the messages changed (supplier before already-allocated).

**Files.**
- `src/modules/accounting/services/ar/invoiceStatusRecompute.ts` — `BALANCE_DERIVED` exported.
- `src/modules/accounting/services/ap/supplierAllocationLines.ts` — allow-list + `assertBillAllocatable`.
- `tests/unit/services/bank/bankAllocationUnwind.test.ts` — its `vi.mock` of the recompute module now uses `importOriginal`, since the allow-list is built from the real export at module load.

**Tests.** Real PostgreSQL (disposable fixture):
- `tests/integration/k063-supplier-payment-settles-unapproved-bill.int.test.ts` — 1 test (validator's RED, now green).
- `tests/integration/k063-supplier-allocation-status-gate.int.test.ts` — 3 tests: `disputed` refused, foreign tenant refused as "not found", and an approved bill still settling with allocations, `amount_paid`, `balance` and payment status in agreement.

**Migration / rollback.** None. Revert the commit to restore the old gate.

**Historical-data impact.** Payments already applied to a bill that never
credited AP: AP control is understated and the bill is invisible in AP aging
while cash has left. Read-only detection (NOT run — production is out of scope):

```sql
SELECT si.company_id, si.id, si.invoice_number, si.status, si.amount_paid
FROM supplier_invoices si
WHERE si.status IN ('pending_approval', 'disputed', 'draft')
  AND COALESCE(si.amount_paid, 0) > 0;
```
Each hit needs a correcting journal; the guard does not repair existing rows.

**Limits.** The AR twin `receiptAllocationLines.ts` carries the same deny-list
shape and was left alone — it is a separate finding, not this defect. In-flight
allocations against a `pending_approval` bill are now refused, which is
user-visible.

## Round 2 (2026-09-21) — reconciled with master 638 commits later

**Still REAL on origin/master c19508a12.** Master reworked `supplierAllocationLines.ts`
(bill `FOR UPDATE` in id order, 5s `lock_timeout`, contention raised as a retryable
`SupplierPaymentRefusal` answered 409, every refusal typed) but kept the deny-list
`UNALLOCATABLE_STATUSES = {cancelled, draft}`. Measured through supplier-allocations
POST: a `pending_approval` and a `disputed` bill each answered **200**, the bill
went to `newStatus: "paid"` and the payment to `reconciled` (`round2-red-master.log`).
Master's own fix for the same class, `FIFO_ELIGIBLE_STATUSES = BALANCE_DERIVED`,
covers the FIFO walk only — not a bill named explicitly.

**Merge.** `invoiceStatusRecompute.ts` taken from master (it already exports
`BALANCE_DERIVED`). `supplierAllocationLines.ts` taken from master and the fix
re-applied inside its structure: the allow-list and `assertBillAllocatable` moved
to a new `billAllocatable.ts` (so the file stays under 300 lines — master's copy
was already 303) and now throw `SupplierPaymentRefusal`, so routes keep answering
400 for them and 409 only for contention. `buildLine` still runs on the rows
`fetchBillCandidates` read under the lock, so the gate sits inside the lock.
`fetchBillCandidates`, `buildLine` and `BillCandidate` are exported for K-064's
batch planner.

**Tests.** The two round-1 service-level files are replaced by
`tests/integration/k063-supplier-allocation-status-gate.int.test.ts`, driven
through the real handler (withAuth, CSRF, write access): pending_approval,
disputed, draft and cancelled each 400 with `amount_paid` 0 and no allocation
row; an approved bill still 200 → paid. Red on master 2/6, green on the branch 6/6.

**Mutation.** Widening the allow-list back to include pending_approval and
disputed turns 5 tests red across the three files (`round2-mutations.log`, M1);
restored byte-identical by sha256.
