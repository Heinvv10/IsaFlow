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
       COALESCE(SUM(DISTINCT cn.applied_amount), 0) AS credited,
       COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa
                 WHERE cpa.invoice_id = ci.id), 0) AS receipted
FROM customer_invoices ci
LEFT JOIN credit_notes cn ON cn.customer_invoice_id = ci.id AND cn.company_id = ci.company_id
                         AND cn.status = 'applied'
GROUP BY 1,2,3,4
HAVING ci.amount_paid <> COALESCE(SUM(DISTINCT cn.applied_amount), 0)
                       + COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa
                                   WHERE cpa.invoice_id = ci.id), 0);
```
A row where `amount_paid` is LESS than credited + receipted is a lost update; MORE is a
double-count. Both directions are now visible. `validation.md` carries a pointer to this.

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
