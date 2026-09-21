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

**Tests.** Real PostgreSQL (disposable fixture): the validator's RED (a `pending_approval` bill) plus `disputed` refused, a foreign tenant refused as "not found", and an approved bill still settling. Round 1's two service-level files were deleted in round 2; `green.log` / `red.log` in this folder are their 2026-09-09 runs and name files that no longer exist. The live tests are listed under Round 2 onward.

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

## Round 4 (2026-09-21) — blind review r1 of b1d018a55

Every finding fixed; the two HIGHs predate this branch but reach the same
outcome (AP relieved for money no bill stands behind). Tests below are all
route-level against the fixture; mutations in `round4-mutations.log`, each
restored byte-identical by sha256; green run in `round4-green.log`.

1. **HIGH — soft-deleted bills.** A soft-delete reverses the approval journal
   but leaves `status = 'approved'`, so the allow-list admitted it (reviewer:
   AP ended at −1,150). Now: `assertBillAllocatable` takes `deleted` and
   refuses first ("has been deleted and cannot receive a payment");
   `lockBillCandidates` adds `AND si.deleted_at IS NULL`, so every locked path
   (bank line, payment application, batch create, both process gates) reads a
   deleted bill as not found; `createSupplierPayment` selects `deleted_at` and
   passes it to the rule. `openSupplierBills` (auto-allocate) already filtered
   it. The delete guard (`softDeleteInvoiceGuards.ts#allocatedByLivePayments`)
   read the dead `supplier_payment_allocations` table, so a bill carrying an
   approved unprocessed payment could be deleted and then processed; it now
   reads `payment_allocations`. `k053-soft-delete-undo-identity` seeded its
   "DRAFT allocation" case into the dead table and passed only because the
   guard read the same dead table — its seed and cleanup now use
   `payment_allocations`; the assertion is unchanged.
   Tests: `tests/integration/k063-deleted-bill-and-batch-member.int.test.ts`
   (new payment 400 "deleted"; batch 400 "not found"; supplier-allocations 400
   "not found"; delete refused while a payment is pending; payment and batch
   whose bill was deleted before processing → 400, document `approved`, AP
   unchanged). Mutations D1 (rule), D2 (lock filter), D3 (dead table) each red.
2. **HIGH — batch member processed twice. Rule: a batch member moves money
   only through its batch.** `processSupplierPayment` refuses a payment with a
   `batch_id` (400, "belongs to batch <id> — process it through its batch"),
   checked under the payment lock after the status check. `processBatch`, via
   `assertBatchMembersStillAllocatable`, refuses (400) if any member is not
   `approved` — stored data may predate the single-path rule. Proven both
   orders: member-then-batch → member 400, batch 200, AP +300, bill 300;
   batch-then-member → batch 200, member 4xx, AP +300 once. Mutations B1, B2 red.
3. **MEDIUM — the 400s crashed or hid.** `batch-payments/[batchId].tsx` and
   `supplier-payments/[paymentId].tsx` rendered `json.error` (an object);
   `batch-payments/new.tsx` read an absent `json.message`. All three now go
   through `assertOk` + `apiErrorMessage`. `tests/unit/components/apPaymentRefusalMessages.test.tsx`
   builds each 400 body with `apiResponse.badRequest` (the routes' serializer)
   and asserts the refusal text renders; reverting each page turns its test red.
   **Browser**: dev server on :3263 against the fixture, headless Chromium, an
   approved batch whose bill is cancelled, Process clicked → the route answered
   400 and the page showed "Invoice K063-UI-BILL is cancelled and cannot receive
   a payment." under the header, no page error (`round4-ui-batch-refusal.png`).
4. **LOW — which payments reserve a bill.** Pinned both ways in
   `tests/integration/k064-reservations-cents-cancel.int.test.ts`: approved and
   draft reserve; cancelled does not; processed reserves nothing beyond
   `amount_paid` (600 accepted, 600.01 refused after a processed 400).
   Mutations R1 (widened to cancelled+processed) and R2 (narrowed to draft) red.
5. **LOW — 1-cent tolerance.** `buildLine` compares `toCents(amount) >
   toCents(outstanding)` with no tolerance, and `confirmSupplierMatch.ts`'s
   pre-write check moved with it (both must agree, or a refusal lands after a
   write). R100.00 takes 100.00 and refuses 100.01; a fully paid bill refuses
   0.01. Mutation C1 (old tolerance) → 3 red. `EPS` stays for payment-side
   totals, which the review did not question.
6. **LOW — dead citations.** Round-1 file names removed from `fix.md` and
   `validation.md` of all three items; every `tests/…`, `src/…`, `pages/…` path
   cited in these folders now exists (checked by script).
7. **MEDIUM (addendum) — unlocked creation and no way out.**
   `createSupplierPayment` now calls `fetchBillCandidates` before reading the
   bills and the pending allocations, so it and a concurrent batch serialise on
   the bill lock; its two refusals ("not found…", "Invalid allocations") are now
   `SupplierPaymentRefusal` → 400 pre-write instead of 500. Test: bill held,
   batch queued, single queued, release → 200 + 400, 1,000 allocated; mutation
   L1 (lock removed) red. Way out — see "Round 4b" below.

Unit files that assert statement ORDER mock the two new DB-backed steps
(`fetchBillCandidates` in `supplierPaymentService.test.ts`,
`assertBatchMembersStillAllocatable` in `batchPaymentService.test.ts`); both
are proved against PostgreSQL above.

## Round 4b (2026-09-21) — MEDIUM-7 in the reviewer's shape

600 + 600 against a 1000 bill, `tests/integration/k064-stuck-loser-recovery.int.test.ts`.

- **Prevented.** `createSupplierPayment` takes the bills through
  `fetchBillCandidates` — the id-order `FOR UPDATE` the batch planner and every
  settlement path use — before reading the bills and the promised allocations.
  Created at once (bill held, batch first, single 150ms later, release): batch
  200, single **400 at creation** ("exceeds invoice … balance"). Mutation L1'
  (lock removed) → red.
- **One lock order, no deadlock.** A single payment, a batch and a
  supplier-allocations apply naming the same two bills in opposite orders,
  queued behind a hold on both and released together: all three 2xx, each bill
  paid exactly what the apply moved. With the create lock removed this test is
  red too.
- **Recoverable** (the stuck state seeded as the unlocked creation left it): the
  winner processes (200); the loser's process is refused 400 "exceeds the
  R400.00 outstanding"; the loser is released through the EXISTING routes —
  `void` on supplier-payments-action for a single payment, `cancel` on
  batch-payments-action for a batch — both 200 and `cancelled`; the remaining
  400 is then created, approved and processed; bill 1000 `paid`, AP debited
  exactly 1000. Both loser kinds.
  - `voidSupplierPayment` on a `draft`/`approved` payment is now a status change
    (`supplierPaymentCancel.ts#voidUnprocessedPayment`): no journal to reverse,
    no `amount_paid` to roll back. A batch member is refused (400, "cancel it
    through its batch"). Any other non-processed status, and `reconciled`, are
    now `SupplierPaymentRefusal` (400) — they were bare Errors, i.e. the **500**
    the reviewer saw. Mutation V1 → red. The round-4 `cancel` action I had added
    to supplier-payments-action is removed; `void` covers it. The payment page's
    button for draft/approved is labelled Void.
  - `cancelBatch` cancels `draft` OR `approved` and refuses anything else with
    400; it no longer answers 200 while matching nothing. Mutation X1' → red.
  - Once voided/cancelled a document stops reserving its bill: the pending set is
    `draft`/`approved` only (pinned in round 4, item 4).
  - The other **500** — supplier-payments POST for the remaining 400 — was
    `createSupplierPayment` throwing a bare `Error('Invalid allocations…')`
    because the stuck allocation still counted as pending; that is a
    `SupplierPaymentRefusal` (400, pre-write) since round 4, and after the void
    the allocation no longer counts.
- `tests/unit/services/supplierPaymentVoid.test.ts`: "rejects voiding a
  non-processed payment" encoded the old rule; it now asserts an approved payment
  voids with no reversal and no bill UPDATE, and a cancelled one is a typed
  refusal.

## Round 5 (2026-09-21) — Cancel restored, alongside Void (Hein's decision)

1693bb0fa removed the round-4 `cancel` action before the decision to keep it
arrived. It is back on `supplier-payments-action`; everything else in 1693bb0fa
stands (Void on a draft/approved payment, cancelBatch for approved batches).

- **What Cancel is.** `supplierPaymentCancel.ts#cancelSupplierPayment`, for money
  that never moved: `draft` or `approved` only. It posts nothing (no journal is
  created or reversed) and flips the payment to `cancelled`, which drops its
  allocations out of the pending set, so the bill can be promised again.
  Refused with 400: a `processed` or `reconciled` payment ("its journal is
  posted. Use Void, which reverses it"), any other status, and a batch member
  ("cancel it through its batch"). The guarded UPDATE now RETURNs and refuses if
  it matched nothing, so neither Cancel nor Void-of-unprocessed can answer 200
  while doing nothing.
- **Same gate as Void, exactly.** Both are actions on the one route, behind the
  one `withWriteAccess` (default roles owner / admin / manager) and `withCsrf`;
  a `viewer` gets 403 on both. Company-scoped: the payment lock and the read
  both carry `company_id`; another company's id is 404. Audit: `log.info`
  'Cancelled supplier payment' with id, userId and the status it left, the same
  structured log Void writes (there is no DB audit trigger on
  `supplier_payments` for either).
- **Cancel racing Process.** Both take `lockSupplierPaymentForUpdate` first, so
  one wins and the other is refused (400 or 409), never 500. 6 concurrent trials,
  order alternated: 3 ended `processed` (journal linked, exactly one journal,
  AP +1000, bill paid) and 3 `cancelled` (no journal, AP unchanged, bill untouched)
  — `round5-cancel-race.log`.
- **UI.** Payment page: "Cancel payment" for draft/approved only, with a
  confirm dialog: "Nothing has been posted for this payment yet. Cancelling stops
  it for good and releases the bills it was going to pay — no journal is created
  or reversed. To undo a payment that has already been processed, use Void
  instead." A processed payment shows "Void (reverse journal)" instead, whose
  dialog says it reverses DR Bank / CR Accounts Payable. Batch page: an APPROVED
  batch shows Cancel next to Process (added in round 4; seen in
  `round4-ui-batch-refusal.png`). **Browser**: dev server on the fixture, an
  approved payment: header buttons "Process" and "Cancel payment"; the dialog
  text above (`round5-ui-cancel-dialog.png`); confirm → POST 200, the server
  logged 'Cancelled supplier payment', the page reloads showing `cancelled` with
  no action buttons (`round5-ui-cancel-after.png`). Seen in passing, not
  changed: the allocations table on that page shows "RNaN" per line.
- **Tests.** `tests/integration/k064-cancel-payment.int.test.ts` (approved and
  draft cancel, processed refused with journal intact, viewer 403 on cancel and
  void, foreign id 404, the race); `tests/unit/components/apPaymentCancelControls.test.tsx`
  (Cancel only for draft/approved and sends `action: cancel`; Void only for
  processed; approved batch shows Cancel). 53 integration files, 352 tests
  (`round5-green.log`).
- **Mutations** (`round5-mutations.log`): removing the processed refusal alone
  still refuses (the second status check), with the wrong words → red; removing
  BOTH checks → the processed payment is answered 200 and left processed → red
  (the RETURNING guard since added makes that a 400 too); dropping
  `withWriteAccess` → viewer 200 → red; removing the Cancel button → 2 red. All
  restored byte-identical.
- `SupplierPaymentNotFoundError` moved to `supplierPaymentNotFound.ts` (re-exported
  from the workflow service unchanged) so the cancel module can raise it without
  a circular import.
