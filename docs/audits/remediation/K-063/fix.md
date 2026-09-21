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

## Round 5b (2026-09-21) — blind review r2 of 1693bb0fa

1. **HIGH — void was a third way around "a batch member moves money only
   through its batch".** Voiding a PROCESSED batch member un-applied its bill
   (amount_paid 300 → 0) while the batch journal's AP debit stood, and the bill
   then took a new 1000. `supplierPaymentGates.ts#voidIfUnprocessed` now refuses
   a batch member in every status, naming the batch. There was no batch-level
   reversal; Hein decided to build one (Round 6), and the message for a
   processed member now says "reverse the batch". Both orders pinned in
   `k063-deleted-bill-and-batch-member`: batch processed then member voided →
   400, member still processed, bill 300, AP +300, a new 1000 refused and 700
   accepted; member voided then batch processed → 400, batch pays once (bill
   300, AP +300). Mutation V2 (void refusal removed) → red.
2. **MEDIUM — the batch-creation page could not build a batch.** It read
   snake_case invoice fields; supplier-invoices answers camelCase
   (`invoiceNumber`, `supplierId`, `totalAmount`, `amountPaid`), and
   suppliers-list answers snake_case with `company_name` often null (the page
   now falls back to `name`). **Browser** (`round5-ui-browser.log`,
   `round5-new-batch-refused.png`): supplier option "K065 Supplier"; invoices
   "K065-BILL-B — R 500,00", "K065-BILL-A — R 1 000,00"; a line of R500 on
   BILL-B (R200 of it already reserved by an approved batch — the browser's own
   `max` cannot see that) → 400 and the page shows "R500.00 exceeds the R300.00
   outstanding on invoice K065-BILL-B."; BILL-A at 1000 → 200 and the page
   returns to the batch list. (An amount above the SHOWN balance never reaches
   the server: the amount input's `max` blocks the submit.)
3. **LOW — contention status.** supplier-payments POST now answers a retryable
   refusal 409, as batch-payments POST does. Pinned (bill held > 5s: both 409,
   nothing written); mutation C409 → red.
4. **LOW — file size.** The process-time gate and the batch-member refusals for
   process and void moved to `supplierPaymentGates.ts`; `toCents` moved to
   `billAllocatable.ts`. `supplierPaymentWorkflowService.ts` 321 lines (master
   333), `supplierAllocationLines.ts` 300 (master 303). Only this change's code
   moved.
5. **LOW — the statement's dead-table join.** Measured before switching:
   joining the live `payment_allocations` would change the statement — a R1,000
   payment with R600 applied showed 600 instead of 1000 (the unapplied R400
   vanishes from what the supplier was paid; a refund's positive allocations
   would also flip its sign). So the join is REMOVED and the figure is the
   payment total, which is what the dead join always fell back to: FULL 1000 /
   PARTIAL 1000 before and after. Pinned in
   `k063-supplier-statement-payment-amount`; all 13 supplier-statement
   integration files pass.
- **"RNaN" on the payment page.** Same class: the page read `invoice_number` /
  `amount`, the API sends `invoiceNumber` / `amountAllocated`. Fixed; browser
  shows "K065-BILL-B  R 200,00" (`round5-batch-member-page.png`). Checked the
  other pages this change touches: the batch detail page read `batch.payments`,
  which the single-batch GET never returned (every batch said "No individual
  payments"); `batchPaymentMembers.ts` now supplies it and the browser lists
  "SP-2026-00001  K065 Supplier  R 200,00  approved".
- **Batch member's page.** No Process, Void or Cancel (each would answer 400);
  instead "This payment is managed in its batch — open the batch", linking to
  it. Seen in the browser; component-tested with the link's href.

## Round 6 (2026-09-21) — reverse a processed batch (Hein's decision on r2 HIGH-1)

`batchPaymentReversal.ts#reverseBatch`, the `reverse` action on
batch-payments-action, a "Reverse batch" button, and migration
`691_supplier_payment_batch_reversed_status.sql` (adds `reversed` to
`supplier_payment_batches_status_check`; schema only, idempotent; 684–690 are
taken on other branches, so 691 is the next unused prefix).

**Approach — one batch-level unwind on the existing primitives, not a void per
member.** Members carry no journal: `processBatch` posts ONE journal (DR AP / CR
Bank, batch total). Voiding member by member would need N partial reversals of
that one journal, which `reverseJournalEntry`'s reversal claim (`reversed_at`)
and migration 619's unique `reversal_of_id` exist to forbid. So the reversal
un-applies each bill by exactly THIS batch's allocations to it (summed per bill,
since a legacy batch can name one bill twice), then calls `reverseJournalEntry`
on the batch journal — so no path, this one included, can post a second contra.
Bill status comes from `recomputeInvoiceStatus` (the owner of the threshold), so
a bill a later payment also paid stays partly/fully paid. Members → `cancelled`
(the status single void leaves); batch → `reversed`. Allocation rows stay as
history; cancelled members are outside the pending set, so they no longer
reserve the bills.

**One transaction** (the request transaction plus a savepoint). **Locks:** the
batch row (`claimUnderLockTimeout`, 5s → 409), then any bank line matched to the
batch journal, then the bills through `fetchBillCandidates` (the shared id
order), then the GL. **Refusals, all before the first write (400):** batch not
`processed`; any member not `processed`; its bank line reconciled (or claimed by
an allocated bank line); a bill no longer showing this batch's money; the
reversal date not in an open period. Already `reversed` (a double-click's loser)
→ 409.

**Closed period.** The date is decided exactly as `reverseJournalEntry` decides
it (`resolveReversalDate`): the original date if its period is open, otherwise
today. Single void does the same, but lets a closed/absent period surface as a
failed post — a 500 that rolls the whole void back. The batch reversal checks
that date's period first and refuses 400 with nothing written.

**Bank leg.** A bank line matched to the batch journal is unmatched
(`unmatchTransaction`, back to `imported`) so the statement line can match
again; reconciled refuses. Single void does NOT touch a matched bank line today
— that gap is single void's, noted, not changed here.

**Proof** (`tests/integration/k064-batch-reversal.int.test.ts`, 8 tests): a batch
of 3 members across 2 bills (X carries two: 300 + 100), processed (X 400, Y 200),
then a later separate 400 on Y processed → reverse → X 0 `approved`, Y 400
`partially_paid`, AP net = before + 400 and bank net = before − 400 (only the
later payment remains), batch `reversed`, members `cancelled`, the later payment
still `processed`, exactly 1 posted contra, trial balance balanced, and X takes a
fresh 1000. Double-click: 200 + 409, one contra. Racing a new payment on Y: 200,
the payment 201 or 400 depending on order, never 500, Y ends 0. Matched bank line
→ `imported`. Reconciled bank line → 400; closed period → 400; each with batch,
members, bill, contras and AP unchanged. Not processed → 400; viewer → 403 (same
`withWriteAccess` as void); a member void → 400 "reverse the batch".
**Mutations** (`round6-mutations.log`): G1 every reversed/processed/reversed_at
check removed → double-click red; G2 each bill decremented by the batch TOTAL → 3
red; G3 reconciled refusal removed → red; G4 batch row lock dropped → red. All
restored byte-identical.

**UI.** "Reverse batch" only on a processed batch (component-tested for
processed / approved / reversed). **Browser** (`round6-ui-browser.log`): on an
approved batch, Process → 200; the page then offered only "Reverse batch"; its
dialog read "This posts a reversing journal (DR Bank / CR Accounts Payable for
R 200,00) and reopens 1 bill by exactly what this batch paid. Every payment in the
batch is voided. Payments made separately stay as they are."
(`round6-reverse-dialog.png`); confirm → 200; the page shows `reversed`, no
action buttons, the member `cancelled` (`round6-reversed.png`); the database
shows the bill back at 0.00 `approved` and one posted contra.
`BATCH_ALREADY_REVERSED` is registered in the MCP refusal allowlist
(`toolHelpers.ts`), which `typedRefusalReachesAgent` requires of every
`readonly code`.

### Round 6 additions

- **The new-batch page shows what the server will accept.** Its invoice list
  subtracted nothing for unprocessed payments, so it offered (and prefilled) a
  bill's raw outstanding and the server then refused it. The pending-set query
  is now one exported function, `supplierBatchAllocationPlan.ts#pendingReservations`,
  used by batch creation under the bill lock AND by a `reservedFor` read on
  batch-payments GET (company-scoped, same statuses: draft/approved). The page
  subtracts it and says so. **Browser**: a R500 bill with R200 reserved by an
  approved payment is listed as "K065-BILL-B — R 300,00 available (R 200,00
  reserved)", the amount prefills 300 with max 300, and creating the batch at 300
  → 200 (`round6-new-batch-available.png`). Pinned in
  `k064-reservations-cents-cancel` (approved counts, voided does not, another
  company's bill invisible) and a component test; mutation U3 (page ignores
  reservations) → red.
- **Evidence for the statement change (round 5b item 5).** Counts measured by
  the lead: the dead `supplier_payment_allocations` table holds **0 rows on
  isaflow_dev and 0 rows on isaflow_staging** (a production copy of
  2026-09-18), against 1,101 and 4,764 live `payment_allocations` rows. The old
  join therefore matched nothing on real data and every payment already fell
  back to its total — removing the join changes no statement output on either.

## Round 7 (2026-09-21) — the bank leg (review r6; Hein folded these into this PR)

One module now owns reversing a payment journal: `ap/paymentJournalReversal.ts`,
used by single-payment void AND batch reversal, so the two cannot drift.
`lockBankLegOf` (first) runs every pre-write refusal about the journal — not
found, not posted, the reversal date's period (the same `resolveReversalDate`
rule `reverseJournalEntry` uses), a reconciled bank line — and locks each bank
line matched to it. `lockJournalAndUnmatch` (last, just before
`reverseJournalEntry`) locks the journal, re-reads its matched bank lines and
unmatches them with `unmatchTransaction`, the one unmatch routine.

**Lock order is the canonical one** (`bank/.claude.md`, table updated): bank →
payment/batch → bills → journal. Both callers take the bank lines from an
UNLOCKED peek of the journal id, as `voidPaymentDocument` does; void then
re-checks under the payment lock that the journal is the one it peeked
(`assertSameJournal`, else a retryable 409). The first cut took the journal
before the bills, which inverts invoices → GL and is exactly the cycle round 9
measured against `voidPaymentDocument`; the unit test that pins void's order was
the guard, and it now asserts bank → payment → invoices → journal.

1. **HIGH — single void left the bank line matched.** Fixed. Test 1: a 450
   payment processed and matched → void 200 → bank line `imported`, no matched
   line; bank GL net back to where it started; the bill back to 0 `approved`; the
   line matches a live journal again (200). (The reconciliation screen lists
   unreconciled lines by status, so `imported` is what makes it reappear there.)
2. **MED — matching a reversed journal.** `assertMatchTargets` now takes the
   target line's journal `FOR SHARE` AFTER the bank row and refuses
   `LINE_REVERSED` when `reversed_at` is set and `journalReversalState` is not
   `reReversed` (a re-reversed journal's posting is back on the books). A
   reversal holds the journal `FOR UPDATE`, so a racing match either waits and is
   refused, or lands before the journal lock and is caught by the re-read — the
   reversal then answers 409 with its savepoint discarded, and the retry unmatches
   it. Proven concurrently: batch reversal vs match 5 trials, single void vs match
   4 trials, both orders — never a 500, never a deadlock, the statement line
   always ends free.
3. **MED — single void 500 in a closed period.** Now a 400 before anything is
   written (payment still processed, bank line still matched, bill and bank GL
   unchanged) — the same pre-check batch reversal runs, from the same function.
4. **LOW — the "reconciled" message.** On a supplier payment, `reconciled` is set
   by `supplierPaymentApplicationService` when the payment is FULLY APPLIED to its
   bills; it has nothing to do with bank reconciliation. The stored meaning is NOT
   changed. The message now says so: "fully applied to its bills (status
   'reconciled' — this does not mean it is on a bank reconciliation). Voiding a
   fully applied payment is not supported yet." It no longer tells the user to
   remove it from a reconciliation it is not on. A truly bank-reconciled journal
   is refused by its bank line's own state. **Open question for Hein:** whether a
   fully applied payment should be voidable (the refusal predates this PR).
5. **LOW — the anomaly refusal is pinned**: test 5 lowers a batch-paid bill's
   `amount_paid` below the batch's share and expects 400 "no longer shows that
   payment"; removing the check (W4) turns it red.
6. **LOW — `BATCH_ALREADY_REVERSED`** keeps its MCP allow-list entry with a
   comment that no agent can receive it yet.
7. **LOW — `reservedFor` accepted 36 dashes** (500 with pg's "invalid input
   syntax for type uuid"). Ids are now checked with the repo's own `UUID`
   (`@/lib/schemas/common`, `z.guid` — it accepts the seeded version-0 ids that
   Zod 4's `z.uuid()` rejects) and a malformed list is refused whole with a 400
   naming the parameter, before any query; the single-batch `id` on the same GET
   is checked the same way. Pinned: dashes, junk and a mixed list → 400 whose
   body matches no `invalid input syntax|uuid|syntax`; a version-0 id → 200
   (mutation U5 red). **Other routes in this change:** 500s go through
   `apiResponse.internalError`, which outside development returns only "An
   internal error occurred"; `batch-payments` POST uses `badRequestFromError`,
   which hides the original outside development. `bank-transactions-action`
   (touched only through `matchTransaction`) still answers ANY thrown error's
   message as a 400 — the pre-existing blanket catch recorded as R-060; not
   changed here.
8. **LOW — reservations unavailable.** A non-OK or failed reservations read now
   lists the bills at their plain outstanding and shows a visible note ("could
   not be loaded… will be refused when you create the batch"). Component test for
   the failure path; mutation U4 (no fallback) red.
- **Known residual, unchanged:** a bank line in `allocated` status (a bank
  allocation posted the payment journal itself) is left as single void always
  left it. Undoing that is `reverseReconciledTransaction`'s job, which
  `voidPaymentDocument` (MCP `void_payment`) already delegates to; the route's
  void does not. Refusing it here broke `backfill-auto-apply-unapplied`
  ("voiding a back-filled payment restores the bills"), so it was not changed.

**Mutations** (`round7-mutations.log`), each restored byte-identical: shared
unmatch removed → 5 red; single void skips the journal lock + unmatch → 3 red;
matching a reversed line allowed → red; match's `FOR SHARE` dropped → both race
tests red; the mid-reversal re-check removed → both race tests red; the
closed-period pre-check removed → void and batch closed-period tests red.
Unit files that queue `sql` results positionally for `matchTransaction` gained
one entry (the journal read); `supplierPaymentVoid.test` mocks the two
DB-backed steps and records where they run. The census entry moved to
`paymentJournalReversal.ts`, the file that now reads `bank_transactions`.
Green: 81 integration files, 517 tests (`round7-green.log`).
