# K-011 fix — lock the invoice before applying a credit note to it

**Trigger.** Two overlapping requests apply credit notes to the same customer invoice: two
approved notes from two tabs, or an MCP agent and a user at once. Also triggers when a receipt
allocation commits while a credit-note apply is in flight.

**Before.** `applyCreditNoteToInvoice` locked the credit NOTE but read the invoice with a plain
`SELECT`, derived `outstanding` and the over-application cap from that unlocked row, then wrote
`SET amount_paid = <absolute value computed in JS>`. The second writer's `UPDATE` blocked on the
first's row lock, then overwrote it with a total computed from a pre-lock read. R100 of customer
credit was consumed — the note recorded `applied_amount` and `status='applied'` — while the
receivable never moved. The cap was computed from the same stale balance, so a note could also be
applied beyond the invoice's remaining outstanding.

**After.** The invoice `SELECT` takes `FOR UPDATE`, keeping the note-then-invoice lock order the
existing comment establishes (so no new 40P01 cycle). The write is now relative,
`SET amount_paid = COALESCE(amount_paid, 0) + ${applyAmount}`, so the statement is correct even if
a future caller reaches it unlocked. `outstanding`, the cap and the write all read one serialised
row, so the cap still bounds the invoice at its own total.

**Files.** `src/modules/accounting/services/ar/creditNoteCancelService.ts` (+8/-2, no new imports).

**Tests.** Real DB (disposable fixture, production schema), two pool clients per case, each waiting
on `pg_stat_activity.wait_event_type='Lock'` so the interleave is not timing-dependent:
- `tests/integration/k011-credit-note-apply-lost-update.int.test.ts` — 1 test (validator's RED).
- `tests/integration/k011-credit-note-apply-adjacent.int.test.ts` — 3 tests: cap under concurrency
  (R150 + R100 on R200 leaves the second at R50 and the invoice at R200/`paid`), a concurrent
  receipt allocation not erased, and a wrong-tenant apply that throws and writes nothing.
4 passed. Mutation check in `green.log`: reverting the production change turns 3 of the 4 red; the
tenant case stays green because scoping is not part of the race.

**Migration / rollback.** None. Rollback is reverting the one commit.

**Historical-data impact.** Invoices already credited by more than `amount_paid` records. NOT RUN
against production from this worktree — read-only probe:
```sql
SELECT ci.company_id, ci.id, ci.invoice_number, ci.amount_paid,
       SUM(cn.applied_amount) AS credited
FROM customer_invoices ci
JOIN credit_notes cn ON cn.customer_invoice_id = ci.id AND cn.company_id = ci.company_id
                    AND cn.status = 'applied'
GROUP BY 1,2,3,4
HAVING SUM(cn.applied_amount) > ci.amount_paid;
```
Rows are invoices still showing a balance the customer was credited for. The same window can
swallow a receipt instead, which this query cannot see — compare `amount_paid` against
`customer_payments` allocations plus applied notes to find those.

**Limits.** The fix serialises writers that go through this function. A writer that updates
`customer_invoices.amount_paid` without taking the row lock first still races with itself; the
relative write limits that to an ordering question rather than a lost update. No correction of
existing rows is included.

---

# Review round — all 5 findings of the blind review of c1d36ffc

**MEDIUM 1 — the cap was not enforced against the receipt path (fixed).** Locking the invoice in
the credit-note path only serialised credit notes against each other. `planAllocationLines`
(`receiptAllocationLines.ts`) computed its `outstanding` cap from an unlocked read and
`applyLineToInvoice` then wrote relatively, so the reverse interleave over-applied: a receipt that
planned R200 against a R200 invoice added its full R200 on top of a credit note that committed R100
in between, leaving `amount_paid = 300.00`. The candidate load now takes `FOR UPDATE OF ci` with
`ORDER BY ci.id` (deterministic acquisition across rows), so the receipt re-reads the settled
balance and refuses BEFORE its first write — which is what the module's plan/apply split and the
`withAuth` COMMIT-under-4xx rule both require. The invoice stays the last lock every path takes.

**LOW 1 — unbounded wait, untyped failure (fixed).** New
`src/modules/accounting/services/ar/customerInvoiceLock.ts` wraps both invoice locks in a 5s
`SET LOCAL lock_timeout` and maps 55P03 to `CustomerInvoiceLockTimeoutError`
(`code: 'CUSTOMER_INVOICE_LOCK_TIMEOUT'`, message says "retry in a moment", which the AR routes
surface). `DEFAULT` is restored on the success path only, never in a `finally` — after a timeout the
transaction is aborted and the restore would throw 25P02 over the typed error. Mirrors
`creditNoteLock.ts` / `core/paymentLock.ts`.

**LOW 2 — module doc (fixed).** `src/modules/accounting/services/ar/.claude.md` gains a
"Recent changes" entry stating the lock ORDER as a rule, not only as a code comment, plus the open
MEDIUM 2. `AGENTS.md` mirrors regenerated; `agent-docs:check` OK.

**LOW 3 — the impact probe under-reports (fixed in docs).** `amount_paid` also carries receipts, so
a corrupted invoice that later took a payment covering the gap drops out of the original `HAVING`.
Widened probe, still read-only and NOT run against production from here:
```sql
SELECT ci.company_id, ci.id, ci.invoice_number,
       ci.amount_paid,
       COALESCE(SUM(cn.applied_amount), 0) AS credited,
       COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa
                 WHERE cpa.invoice_id = ci.id), 0) AS receipted
FROM customer_invoices ci
LEFT JOIN credit_notes cn ON cn.customer_invoice_id = ci.id AND cn.company_id = ci.company_id
                         AND cn.status = 'applied'
GROUP BY 1,2,3,4
HAVING ci.amount_paid <> COALESCE(SUM(cn.applied_amount), 0)
                       + COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa
                                   WHERE cpa.invoice_id = ci.id), 0);
```
A row where `amount_paid` is LESS than credited + receipted is a lost update; MORE is a
double-count. Both directions are now visible. `validation.md` carries a pointer to this.
No `DISTINCT` on the credit-note sum: two notes applied to one invoice for the SAME amount are the
ordinary case and would collapse into one, understating `credited` and reporting a healthy invoice
as a double-count. There is no fan-out to defend against — the receipts term is a scalar subquery,
not a second join, so the `LEFT JOIN` cannot multiply rows.

**MEDIUM 2 — partial application strands credit (NOT fixed; pre-existing).** `approveCreditNote`
credits AR with a note's FULL `total_amount`, while `applyCreditNoteToInvoice` caps at the invoice's
outstanding and then sets `status='applied'`, which the status guard will not re-admit. The
remainder is stranded and GL diverges from the AR subledger by it. It cannot be corrected in place:
`credit_notes` holds ONE `customer_invoice_id`, and `cancelCreditNote` un-applies through that same
column, so spreading a note across two invoices needs a link table and a rewrite of cancel. Left for
a separate change. The adjacent test that exercises the cap now carries a comment naming the
stranded amount as a known divergence rather than reading as an endorsement, and the module
`.claude.md` records it as open. Probe for existing exposure:
```sql
SELECT company_id, id, credit_note_number, total_amount, applied_amount,
       total_amount - applied_amount AS stranded
FROM credit_notes
WHERE status = 'applied' AND applied_amount < total_amount - 0.01;
```

**Tests added.** `tests/integration/k011-invoice-lock-review.int.test.ts` — 3 tests: the reverse
interleave refuses and leaves `amount_paid = 100.00`; the lock gives up on the 5s budget with the
typed retryable error and writes nothing; a successful apply leaves no `lock_timeout` in force for
the rest of the request. All three go red against c1d36ffc (`green.log`).

---

# Register item — MEDIUM 2, open, NOT fixed in this branch

**What.** `approveCreditNote` credits the AR control account with a credit note's FULL
`total_amount` (`creditNoteApproveService.ts:62-63`). `applyCreditNoteToInvoice` absorbs only
`min(total_amount, invoice outstanding)` into the subledger and then sets `status='applied'`, which
the apply guard will not re-admit. The unabsorbed remainder is stranded: the GL and the AR aging
diverge by it, permanently, for every partially applied note.

**Why it is not fixed here.** `credit_notes` carries ONE `customer_invoice_id`, and
`cancelCreditNote` un-applies through that same column. Letting a note span two invoices needs a
link table and a rewrite of cancel — a schema migration behind a concurrency fix.

**Exposure — NOT RUN. Read-only, safe on production:**
```sql
SELECT company_id,
       COUNT(*)                                    AS notes,
       SUM(total_amount - applied_amount)          AS stranded_credit
FROM credit_notes
WHERE status = 'applied'
  AND applied_amount < total_amount - 0.01
GROUP BY company_id
ORDER BY stranded_credit DESC;
```
Per-note detail, same predicate:
```sql
SELECT company_id, id, credit_note_number, credit_date, customer_invoice_id,
       total_amount, applied_amount, total_amount - applied_amount AS stranded
FROM credit_notes
WHERE status = 'applied' AND applied_amount < total_amount - 0.01
ORDER BY stranded DESC;
```
`stranded_credit` is the amount by which the AR control account is credited more than the aging, per
company. Supplier notes (`type='supplier'`) carry the mirror defect against AP.

---

# Round 3 — the four findings of the re-review of aef352ec

**MEDIUM A — the typed retry error never reached two of its three callers (fixed).** Both filters
between a service error and a caller key on `code === undefined`, because a pg driver error always
carries a SQLSTATE and could leak schema names. All seven lock helpers set a `code` too, so their
timeouts were discarded with the driver errors: `receipt-match/confirm.ts` turned routine 5s
contention into a 500, and `safeErrorText` gave an MCP agent the generic fallback rather than
"retry in a moment". New `src/lib/lockTimeout.ts` exports `isLockTimeoutError` (a `code` that is a
string ending in `_LOCK_TIMEOUT`, which no five-character SQLSTATE can be) and `isCallerSafeError`;
`isRefusal` and `safeErrorText` both use the latter. Driver errors are still hidden, including a raw
55P03 that reaches them unmapped.

**LOW B — the invariant sentence was false (fixed).** "The invoice is always the LAST lock" is
contradicted by `customerInvoiceCancelService`, which holds an invoice and then locks
`gl_journal_entries`. The ordering CONCLUSION stands — the only path holding a journal row when it
reaches an invoice is `cancelCreditNote`, and the journal it holds is the note's — so the wording in
`customerInvoiceLock.ts` and `ar/.claude.md` now states the order that is actually true
(note/payment/bank-line before invoice) and the narrow rule: never take a note or payment lock while
holding an invoice lock.

**LOW C — `SUM(DISTINCT ...)` in the widened probe (fixed).** Dropped, with the reason recorded
above the query.

**LOW D — the cancel path's un-apply was still unbounded (fixed).** `cancelCreditNote` moves
`amount_paid` with a guarded `UPDATE` and never reads the row, so it took the invoice lock through
the statement with no budget while already holding the credit note. The customer branch now runs
inside `withCustomerInvoiceLock`; the supplier branch inside a new `withSupplierInvoiceLock` in
`ap/supplierInvoiceLock.ts`, reusing that module's existing typed error.

**Tests.** `tests/unit/lib/lockTimeoutSurfacing.test.ts` — 7 tests over the three typed lock errors,
the two filters, and four driver SQLSTATEs including 55P03. Reverting `isCallerSafeError` to the old
predicate turns 2 of them red. `tests/integration/k011-invoice-lock-review.int.test.ts` gains a
fourth real-DB test: the cancel gives up inside the budget with the typed error and leaves the note
applied and the invoice's credit intact. Reverting the cancel wrapping makes it hang to the 30s
timeout.

---

# Round 4 — the three findings of the re-review of b048bb07

**LOW E — the new test's closing comment credited the wrong mechanism (fixed).** It read as though
the cancel refusal was safe because the transaction rolled back, but that rollback is the test's
own. Production answers 400 and `withAuth` COMMITs for any status under 500. The outcome is still
correct, for a reason the comment now names: 55P03 has already ABORTED the transaction, so that
COMMIT degenerates to a rollback and the journal reversal `cancelCreditNote` issued earlier cannot
survive. The comment also now says what that guarantee does NOT cover — see the register item below.

**LOW F — the `_LOCK_TIMEOUT` suffix is load-bearing and one error dropped it (fixed).**
`isCallerSafeError` decides on that suffix whether a typed error's message may reach a caller, so
`ReclassLineLockTimeoutError`'s `RECLASS_LINE_LOCKED` was one `safeErrorText` adoption away from
silently losing its retry wording. Renamed to `RECLASS_LINE_LOCK_TIMEOUT`; its single consumer in
`reclassificationShared.ts` updated. The convention is now enforced by a test that enumerates all
seven classes rather than by a comment.

**LOW G — two classes shared one code (fixed).** `customerInvoiceApprovalService` declared a second
`CustomerInvoiceLockTimeoutError` with the same `CUSTOMER_INVOICE_LOCK_TIMEOUT` code as
`customerInvoiceLock`, so `bulkApproveRunner`'s retryable-skip list matched both while nothing could
tell an approval-path timeout from an apply-path one. They mean the same thing, so the approval
service now imports and re-exports the one class; the throw site passes `Customer invoice <id>` so
its message is unchanged. The new test asserts all seven codes are distinct.

**Tests.** `tests/unit/lib/lockTimeoutSurfacing.test.ts` grows to 15: every typed lock error is
enumerated and must carry the suffix, be caller-safe, and say "retry in a moment", and all seven
codes must be distinct. Restoring `RECLASS_LINE_LOCKED` turns it red.

---

# Register item — cancelCreditNote can commit a GL reversal behind a 400

**Pre-existing, NOT introduced and NOT fixed here. Found while reviewing the round-3 change.**

`cancelCreditNote` reverses the note's journal (`creditNoteCancelService.ts:50-57`) BEFORE it
un-applies the invoice (`:71-91`). The un-apply's own refusal — "Cannot cancel credit note X:
invoice Y has less applied than the Z this note credited" — is a hand-thrown Error on a LIVE
transaction. `credit-notes-action.ts:52-56` catches everything and answers 400, and `withAuth`
COMMITs for any status under 500. So that refusal commits the GL reversal while the receivable is
never restored: the AR control account moves and the aging does not.

The lock timeout added in round 3 does NOT have this problem — 55P03 aborts the transaction, which
was verified on the fixture DB — and this is why the distinction is now written into the test.

**Fix (separate change):** take the invoice lock and run the `amount_paid >= unapply` check
immediately after the note lock, before `reverseJournalEntry`, so every refusal in this function is
pre-write. Lock order stays legal: note, then invoice, then journal.

**Exposure — NOT RUN. Read-only:**
```sql
SELECT je.company_id, je.id AS reversal_entry_id, je.entry_date, cn.id AS credit_note_id,
       cn.credit_note_number, cn.status, cn.applied_amount
FROM credit_notes cn
JOIN gl_journal_entries je ON je.reversal_of_entry_id = cn.gl_journal_entry_id
                          AND je.company_id = cn.company_id
WHERE cn.status <> 'cancelled';
```
A reversal whose credit note is still `approved`/`applied` is a cancel that committed its GL half
and then refused. Confirm the column name for the reversal link before running — this repo has
carried more than one shape for it.
