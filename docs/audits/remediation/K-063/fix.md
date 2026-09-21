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

## Round 3 (2026-09-21) — the process-time gap

**The gap.** Round 2 guarded creation only. `processSupplierPayment` and
`processBatch` — where DR Accounts Payable / CR Bank is posted and `amount_paid`
moves — read no bill state. Reproduced on the branch tip `5a732e49a`
(`round3-red-tip.log`): a payment created and approved against an approved bill,
the bill then cancelled / disputed / sent to pending_approval / draft / reassigned
to supplier A2, then processed → **200**, the bill `paid` (R1,000), the payment
`processed` with a journal, AP debited R1,000. The batch twin (R400 + R1,000
lines, the higher-id bill changed) → 200, both bills settled, AP debited R1,400.
That is this item's claim — a payment relieving AP for a bill that is not a
payable — reached by a different ordering.

**Fix: one rule, where the money moves, under the lock, before any write.**
`supplierBatchAllocationPlan.ts#assertAllocationsStillAllocatable` runs the
stored allocations through the SAME `fetchBillCandidates` (id-order `FOR
UPDATE`, 5s timeout, retryable refusal) and `buildLine` → `assertBillAllocatable`
the create paths use — status, supplier, tenant (not found) and outstanding. No
second copy of the rule. Unprocessed payments are not counted here: this payment
is one of them, and `amount_paid` is what the bill has actually taken.
- `processSupplierPayment`: payment row lock (existing, first) → status must be
  `approved` (checked under that lock, so a double-click's loser still gets the
  409 "not approved", not a misleading "bill already paid") → bill gate → claim.
- `processBatch`: NEW `SELECT … FOR UPDATE` on the batch row (document first,
  then bills — the same order as the single path) → status must be `approved` →
  every allocation of every payment in the batch, with its own payment's
  supplier → claim.
- batch-payments-action answers the refusal 400 (retryable → 409); the
  single-payment action route already answered `SupplierPaymentRefusal` 400 and
  retryable contention 409.

**What happens to the refused document.** Nothing: it stays `approved`, with no
journal and no `processed_at`, and its bills are untouched — the refusal is
raised before the claim UPDATE, the first write. The user can fix the bill
(re-approve, resolve the dispute, restore the supplier) and process again, or
void/re-allocate the payment. It cannot end half-processed.

**Tests.** `tests/integration/k063-k066-process-time-gate.int.test.ts` (route
level, 11 tests): the five changes × single payment and × batch (the bad bill is
the batch's LAST line in gate order) each → 400 with bills, document status,
journal link and the AP account's debits all unchanged; an untouched bill still
processes (200, paid, AP +1,000). Red on the tip 10/11, green 11/11. Full set:
17 files, 146 tests, plus 4 more process-path files 21 tests (`round3-green.log`).
The two unit files that assert `processBatch` / `processSupplierPayment` statement
ORDER mock the gate module (it is proved here against PostgreSQL) and the batch
one gained the two new statements in its positional mock queue.

**Mutations** (`round3-mutations.log`), each restored byte-identical by sha256:
P1 remove the single-payment gate → 5 red; P2 remove the batch gate → 5 red;
P3 batch route stops typing the refusal (500) → 5 red; P4/P5 move the gate AFTER
the claim → 5 red each, asserting `status: 'processed'` where `'approved'` was
expected — the `withAuth`-commits-a-4xx trap, measured.

## Fixture used for rounds 2 and 3 (for an independent rebuild)

`fixture-build.log` is the full output of the script that built it.
1. `pgvector/pgvector:pg16` (the dump needs `vector`), SSL on with a self-signed
   cert (`scripts/apply-migrations.ts` hardcodes `ssl`), database
   `isaflow_schema_fixture`.
2. Roles first: `app_user` NOLOGIN, `platform_admin` LOGIN BYPASSRLS,
   `migration_admin` NOLOGIN.
3. Schema-only `pg_dump --no-owner` of `isaflow_dev` (301 tables, supplied by the
   team lead; 0 errors on load), then its 340 `schema_migrations` rows (max 683).
4. `bun scripts/apply-migrations.ts`: dev is tracked to 683 but 53 files below it
   are untracked. The runner applied, in order, 524, 525, 526, 527, 528, 529, 530,
   531, 532, 533, 535, 540, 570, 580, 581, 605 — all ok — and stopped at **606**
   (`gl_accounts_company_id_fkey`: it back-fills named tenants that an empty
   database does not have; data only).
5. The rest one by one in version order with `psql -1 -v ON_ERROR_STOP=1`: ok —
   607, 608, 609, 616–620, 623–625, 627, 644–649, 651, 654, 657–660, 662–666,
   669–672, 674. Failed — **606** (as above), **615** (`cannot drop columns from
   view`: the AP back-fill view, since redefined by 679/680 which the dump
   already carries), **626** (`column "user_id" does not exist`: practice rate
   overrides). None of the three touches the tables these tests read.
6. **681 re-applied.** 540 (applied in step 4, i.e. AFTER dev's already-applied
   681) re-creates `supplier_payments_payment_method_check` /
   `customer_payments_payment_method_check` without `'refund'`, which failed 13
   `supplier-refund-document` tests. Lines 76–85 of `681_supplier_refund_documents.sql`
   (the two DROP/ADD CONSTRAINT pairs) were run again. This is an artefact of
   replaying 540 out of order, not a defect in either migration.
