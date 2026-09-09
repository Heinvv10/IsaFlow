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
