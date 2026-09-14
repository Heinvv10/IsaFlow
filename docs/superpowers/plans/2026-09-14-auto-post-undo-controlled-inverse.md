# DECISION 2 — design input: a controlled inverse for auto-post undo

Investigation only. No recommendation on whether to build this, and no code.

## The defect

`bank/autoPostUndoService.undoRow` (master's version, taken wholesale in merge `0e56caf74`) calls
`unwindBankAllocationApplication(companyId, journalEntryId)` when a person has ALREADY reversed an
auto-posted journal by hand. On this branch `bank/bankAllocationUnwind.ts` retired both entry points
to **throwing stubs** — deliberately, in `9c259b89c`, which moved settlement inverses onto the
controlled `voidPaymentDocument` and the approved AR/AP services. The merge made master's caller the
stub's **only** caller.

Inside the per-row savepoint it fails closed: the row counts `failed`, the run stays open, the
operator is told. But undo of a hand-reversed row can never complete. Pinned by 2 failures in
`tests/unit/services/bank/autoPostUndoService.test.ts`.

The stated blocker was that `voidPaymentDocument` is addressed **by payment document** while
`undoRow` holds a **journal id**. That blocker is smaller than it looked.

## 1. The journal → payment document link EXISTS, and it is one column

There is no `payment_documents` table. A payment document is a row in `customer_payments` or
`supplier_payments`. Both carry a direct FK to the journal:

- `supplier_payments.gl_journal_entry_id UUID REFERENCES gl_journal_entries(id)` —
  `scripts/migrations/sql/201_accounts_payable.sql:96`
- `customer_payments.gl_journal_entry_id UUID REFERENCES gl_journal_entries(id)` —
  `scripts/migrations/sql/202_accounts_receivable.sql:24`

So the reverse lookup is a plain indexed predicate, no join:
`WHERE company_id = $1 AND gl_journal_entry_id = $2`. That is exactly what the retired
`unwindBankAllocationApplication` did, and its header says so: *"Payments are found by
`gl_journal_entry_id`, which both apply paths already stamp, so nothing new has to be recorded to
make a reversal exact."* Migration `615_ap_payment_document_backfill.sql` depends on the same link.

`undoRow` holds `jeId` from `bank/autoPostHandOffset.ts:73-82` (`matched_journal_line_id` →
`gl_journal_lines.journal_entry_id`, else `provisional_je_id`) — the same value that gets stamped.

**Not relevant, checked and ruled out:**
- `gl_journal_entries.source_document_id` — FKs `captured_documents` (`409_capture_and_evidence_ledger.sql:75-86`).
  OCR/capture provenance.
- `gl_journal_entries.source_record_id` (`526_gl_je_source_record_id.sql:23`) — polymorphic, keyed by
  `source`; holds the **bank transaction** id for an allocation (`bank/bankAllocationEffect.ts:30`)
  and the **batch** id for a batch payment (`ap/paymentBatchExecution.ts:32`). It is the forward link
  (journal → cause), never journal → what the journal minted.

**Caveat:** the link is journal-scoped, not bank-line-scoped. `core/paymentVoidService.ts`
(`findBankTransactions`) records ten production journals carrying two bank lines each (transfer
legs); migration 615 guards the same shape as `journal_shared_by_bank_lines`.

## 2. Cardinality — NOT one-to-one

| Path | Payment documents per journal |
|---|---|
| Bank allocation / bank rule auto-post | exactly one, or zero |
| Receipt allocated across several invoices | **one** payment, N allocation rows |
| `executePaymentBatchEffect` | **N payments, one journal** |

- `bank/bankAllocationChildEffect.ts:16-49` inserts a single payment row and returns one id; `null`
  for an account-kind plan and for a refund. The rule sweep is not a separate writer —
  `bank/bankRuleAutoPostLine.ts:141` calls `allocateTransaction`, so it gets the same intent,
  receipt, payment document and `parentControl` as the attended path.
- A multi-invoice receipt fans out in `customer_payment_allocations` / `payment_allocations`
  (`bankAllocationChildEffect.ts:31-47`), **not** in documents.
- `ap/paymentBatchExecution.ts:31-46` creates **one** journal (`source:'auto_batch_payment'`, DR AP /
  CR bank for the whole batch) and then stamps **every** payment in the batch with it.

Master's retired unwind handled the fan-out correctly — it selected all payments on the journal, per
kind, and looped. Any payment-addressed replacement inherits that.

A batch journal is **not reachable from `undoRow` today** (it only walks journals tagged by
`bank_transactions.auto_post_run_id`), but the cardinality is a property of the schema, and
`voidPaymentDocument` is shared with the MCP void tools. *Not exhaustively proven that no path
stamps `auto_post_run_id` on a batch-settled bank line.*

## 3. What the inverse must reverse, and in what order

**Canonical lock order, verbatim at `src/modules/accounting/services/bank/.claude.md:34`** (the AP,
AR and core `.claude.md` files all defer to it):

> (1) `bank_transactions`, (2) `customer_payments`/`supplier_payments`,
> (3) `customer_invoices`/`supplier_invoices` (a SET of them `ORDER BY id`),
> (4) `gl_journal_entries`/`gl_journal_lines`.

Breaking it yields 40P01, which `withAuth` answers as a 500. Related rules in the same file:
build the ordering table **mechanically** from every `UPDATE`/`DELETE`/`FOR UPDATE`, not from
explicit `FOR UPDATE`s alone (`:36` — that omission is how `voidSupplierPayment` deadlocked while
missing from the table); a row INSERTed by this transaction does not enter the ordering (`:81`), but
a **pre-existing** journal — which is what an undo reverses — does; five paths take a lock purely to
fix the order and removing any re-opens the deadlock (`:82`); and *"Do not settle a suspected cycle
by argument"* (`:84` — round 8 argued no cycle was reachable, round 9 measured 40P01).

**Write order is separate from lock order and also fixed: unwind the applications BEFORE reversing
the journal.** Both `core/paymentVoidService.ts` ("ORDER IS LOAD-BEARING") and master's unwind header
give the same reason — reversing first returns the credit to the AR/AP control account while the
invoice still reads settled, widening the subledger-to-control gap behind an ordinary-looking
reversal journal.

For several documents on one journal the sequence must be: lock the bank line(s) → lock all payments
(a set, needing a deterministic order) → lock each document's invoices `ORDER BY id` → unwind every
document's applications → reverse the journal **once**, last. The journal is shared, so it cannot be
reversed per document.

**Partial failure is possible.** `undoRun` wraps each row in `withSavepoint(UNDO_ROW_SAVEPOINT, …)`;
a failing row rolls back alone and counts in `skippedBy.failed`, and `undone` is true only when
`skipped === 0`. That is per **bank row**, not per payment document — a multi-document journal would
roll back wholly within that savepoint provided every write stays inside it. Two residual hazards
the module docs already name: a savepoint that rolls back cleanly leaves the request transaction
live, and whatever the request wrote earlier COMMITs behind a 4xx (`bank/.claude.md:83`, measured on
`applyRules`); and `withAuth` COMMITs below 500, so every refusal must be decided from reads before
the first write (`:31`).

If a partial failure escaped a savepoint, the state left behind is the one master's unwind header
enumerates: invoice still carrying `amount_paid` and reading settled, journal reversed so the credit
is back on the control account, bank line back at `imported` and re-allocatable, and the payment
document at `reconciled` — a status `cancelCustomerPayment` refuses, so **no existing service could
clean it up**.

## 4. Approval policy — same rule population, own operation name

`approval_rules` has **no operation column**, only `document_type`
(`scripts/migrations/sql/234_approval_workflows.sql:4-16`); policy is selected via
`operationRuleType` (`controls/operationPermissions.ts:1-38`), and every operation on this path maps
to the **same `'payment'`** rule type — `bank_allocation.post`, `bank_allocation.reverse`,
`customer_payment.cancel`, `supplier_payment.void`, `supplier_payment.process`,
`supplier_payment_batch.process`, `cash_application.apply`/`.reverse`. (`journal.post`/`journal.reverse`
map to `'journal_entry'`.)

So there is **no separate reversal policy family**: the inverse is bound by the same amount
thresholds as the forward posting, but is a distinct operation name with its own approval record,
entity type and reservation. Existing inverses (`controls/operationMaterializer.ts:33-52`):
`bank_allocation.reverse` on a prepared `bank_allocation_reversal_intent` entity (not the bank line),
`supplier_payment.void` on `supplier_payment`, `customer_payment.cancel` on `customer_payment`; each
registers a generated-journal permit for `journal.reverse`.

A new inverse operation name would have to be added to `operations`, to `canonicalOperationRef`'s
per-entityType allowlist, and — if it carries a correction date — to its reversal list
(`operationMaterializer.ts:53`). `bank/bankAllocationLegacyProvisional.ts:16` states the intended
stance: *"The reversal itself is the SAME controlled operation (`bank_allocation.reverse`) under the
same approval policy."*

## 5. The principal — a real human; the problem is TIMING, not identity

`undoRun`'s only callers are `pages/api/accounting/bank-auto-post.ts:127` (behind
`withAuth`/`withWriteAccess`/`withCsrf`) and `bank/autoPostHandCorrection.ts:153` — same route. So
`userId` is the authenticated request user. `requireControlTx()` refuses unless
`principal.personId === store.userId` and `principal.companyId === store.companyId`
(`controls/context.ts:66-79`), and `makeControlPrincipal` rejects `authMethod` `'job'` or
`'platform_import'` (`:46-48`). This matches the forward side, where our branch changed the sweep to
post as the request principal (`bank/bankImportService.ts:82-89`): a synthetic `00000000-…` user was
refused as a context mismatch, poisoning the transaction and 500ing the whole statement.

**But an approval is an id passed in, never minted inline.** `executeControlledOperation(ctx,
operation, opts?.approvalId ?? null, …)`; no id plus a matching policy → `ApApprovalRequiredError`,
`OPERATION_APPROVAL_REQUIRED`, 409 (`ap/apControlBoundary.ts:6-13,25`). The only caller of
`voidPaymentDocument` in the tree is `src/lib/mcp/tools/writeVoidPayments.ts`, where `approval_id` is
**required** (`:53`). And `assertIndependentRequestReview` (`controls/independentReview.ts:31-50`)
means the approver cannot be the impersonated or the same session — it is a second person's act.

`undoRun` iterates rows inside one request transaction and has no channel to ask. So an approval
would have to be obtained **before the sweep starts, per line** — and `approvalId` is a single scalar
bound to one operation/entity, so one pre-obtained approval cannot cover a run of N lines. Either the
undo becomes per-line and pre-approved (the shape `autoPostHandCorrection.undoAnyway` already has:
one line, one recorded decision), or the sweep must skip-and-count `approval_required` the way the
forward sweep does.

**A consequence worth weighing.** The forward sweep already skips on policy:
`bank/bankRulesAutoPostPreflight.ts` returns `{kind:'approval_required'}` when any `payment` rule
matches the amount, and the line is left unposted. So **every line an auto-post run actually posted
is, by construction, a line whose amount did not match any active `payment` rule at post time.**
Since the inverse shares the `'payment'` rule type and the same amount, the same policy population
would generally return no match for the inverse either — unless the company's rules changed between
post and undo, or the inverse binds a different amount.

*I did not verify what amount a payment-addressed inverse would bind (`material.binding.amount` for a
reversal intent), so I cannot state the policy is always vacuous here — only that it is vacuous for
the same rules and the same amount.*

One further refusal carries over: an aggregate-window policy (`aggregate_window_days !== null`) is
one the kernel cannot evaluate for a bank allocation and becomes `AGGREGATE_POLICY_UNEVALUABLE`.

## Not determined

- The amount a payment-addressed inverse would bind, hence whether `matchApprovalRules` could match
  it where the forward post did not.
- Whether a batch journal can ever be reached from `undoRow` (not reachable via `auto_post_run_id`
  today; not exhaustively proven).

No tests, build or database were run; all schema claims are read from `scripts/migrations/sql/*.sql`
and from the code.
