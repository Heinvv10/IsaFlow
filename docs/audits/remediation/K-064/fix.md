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

**Tests.** Real PostgreSQL (disposable fixture): the validator's two RED cases (foreign tenant, over-payment) plus a same-tenant other supplier, one bill named by two payments, and a valid batch processed with the AP debit equal to what its bills took. Round 1's two service-level files were deleted in round 2; `green.log` / `red.log` in this folder are their 2026-09-09 runs and name files that no longer exist. The live tests are listed under Round 2 onward.

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

## Round 2 (2026-09-21) — reconciled with master 638 commits later

**What R-068 (`adbe783a1`) covers.** `createBatch` now refuses a payment whose
`supplierId` belongs to another company. It still reads no bill.

**Still REAL on origin/master c19508a12**, measured through batch-payments POST
(`K-063/round2-red-master.log`): company B's bill under our own supplier → **200**
and a batch written; R1,500 on a R1,000 bill → 200; supplier A2's bill on a
supplier-A payment → 200; a pending_approval bill → 200; one bill named by two
payments (R600 + R600 on R1,000) → 200; a second batch for a bill an earlier
unprocessed batch already pays in full → 200. And a bill row-locked by another
request made the POST wait with no bound (20s test timeout): the FK check on
`payment_allocations` waits on the lock with no `lock_timeout`.

**Merge.** `batchPaymentService.ts` taken from master (keeps R-068 and the
`processBatch` claim). The round-1 `assertBatchAllocatable` called
`planSupplierAllocationLines` once per payment, before any request transaction;
on master that function takes `FOR UPDATE` and REQUIRES the request transaction,
and one call per payment would lock bills in a different order per request. So it
moved to a new `supplierBatchAllocationPlan.ts` and was rebuilt:
1. shape (positive amounts, no bill twice) checked across the WHOLE batch;
2. ONE `fetchBillCandidates` read over every bill in the batch — the same id-order
   lock, 5s timeout and retryable refusal the rest of the settlement path uses;
3. AFTER the lock, allocations of unprocessed (`draft`/`approved`) payments are
   added to `amount_paid` before the balance check. This closes the round-1 limit
   ("two separate batches can still each claim a bill's full balance"): a
   concurrent batch on the same bill waited on the lock, and under READ COMMITTED
   the later statement sees what it committed;
4. every line through `buildLine` — tenant (not found), supplier, status
   (`assertBillAllocatable`), outstanding.
It runs after R-068's loop and before `withTransaction`, so nothing is written
when any line is refused. batch-payments POST answers a retryable refusal **409**
and any other `SupplierPaymentRefusal` 400; everything else keeps master's
handling.

**Partial-write trap.** `withAuth` COMMITs a 4xx. The test "refuses a batch whose
LAST line is the bad one" sends payment 1 (valid) and payment 2 (valid line, then
an over-paying line) and asserts 400 with zero new batches, payments and
allocations. Mutation M8 moves the gate inside `withTransaction` after the
INSERTs: 5 tests go red, including that one.

**Tests.** The two round-1 files are replaced by
`tests/integration/k064-batch-payment-guarded.int.test.ts` (route-level, 9
tests): the six refusals above each 400 with nothing written; a row-locked bill →
409 with nothing written; a valid two-supplier batch → 200, then approve + process
→ bills paid 400 / partially_paid 250, journal balanced, AP debit 650. Red on
master 9/9 in the full run (the happy path only as collateral of the hung
contention request — it passes alone on master); green 9/9 on the branch.

**Mutation** (`K-063/round2-mutations.log`): M4 remove the call → 9 red; M5
ignore pending allocations → the earlier-batch case red; M6 per-payment shape
check → the two-payments case red; M7 route answers contention 400 → the 409 case
red; M8 gate after the writes → 5 red. All restored byte-identical by sha256.

**Round 3.** `processBatch` now re-checks every bill at process time — batch row
locked, then its bills, refused 400 before the claim with the batch left
`approved` (see `K-063/fix.md` "Round 3"). Still open: `createSupplierPayment`
reads bills without a lock, so a single payment and a batch created concurrently
can both count the same outstanding at creation; the process-time gate then
refuses whichever is processed second if the bill no longer has the room
(the same `buildLine` outstanding check; this ordering is not separately tested).

## Round 4 (2026-09-21)

Blind review r1 findings for all three items — soft-deleted bills, batch members processed twice, the UI refusals, the reservation set, integer-cent comparison, dead citations and unlocked payment creation — are fixed and recorded once, in `K-063/fix.md` "Round 4".
