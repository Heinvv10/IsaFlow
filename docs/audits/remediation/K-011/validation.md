# K-011 — credit-note apply writes an absolute amount_paid from a stale read

**Claim (audit A C8 / B F05):** the invoice is read without a lock and `amount_paid` written
absolutely, erasing a concurrent receipt or a second credit note.

**Disposition: confirmed** (as stated).

**Mechanism.** In `applyCreditNoteToInvoice`
(`git show ebeac9ca:src/modules/accounting/services/ar/creditNoteCancelService.ts`) the credit NOTE
is locked at line 140 via `lockCreditNoteForUpdate`, but the INVOICE is read with a plain
`SELECT * FROM customer_invoices` at lines 145-148. `outstanding` and `applyAmount` are derived
from that unlocked row (:155-157) and the result is written absolutely:
`SET amount_paid = ${newPaid}` where `newPaid = Number(inv.amount_paid) + applyAmount` (:159-164).
The note lock therefore protects the note against double-consumption but does nothing for the
invoice. Any second writer of `customer_invoices.amount_paid` — a different approved credit note,
or a receipt allocation — that reads before this write is erased by it.

**Reachability.** Exported through `creditNoteService`; reached from the credit-note apply API and
MCP tooling. Two approved notes for one customer, applied from two tabs or by an agent and a user
at once, is the ordinary case. File unchanged between 5661d6f0 and ebeac9ca.

**Evidence.** RED test `tests/integration/k011-credit-note-apply-lost-update.int.test.ts`
(1 test / 1 failed — `docs/audits/remediation/K-011/red.log`). Two R100 and R50 approved notes are
applied to one R200 invoice from two request transactions on separate pool clients; the test waits
until the second is genuinely blocked on the first's row lock (`pg_stat_activity.wait_event_type =
'Lock'`) before committing, so the interleave is not timing-dependent. Result:
`expected '50.00' to be '150.00'` — both notes record `applied_amount` totalling R150 and both are
`status='applied'`, while the invoice shows `amount_paid = 50.00`. R100 of customer credit is
consumed and never reduces the receivable.

**Proposed minimal fix** (`creditNoteCancelService.ts:145-148`):
- Add `FOR UPDATE` to the invoice SELECT, keeping the note-then-invoice lock order the comment at
  lines 128-139 already establishes, so `outstanding`, the cap and the write all use the same
  serialised row.
- Optionally tighten the write to `SET amount_paid = COALESCE(amount_paid, 0) + ${applyAmount}` so
  the statement is correct even if a caller ever reaches it without the lock.

**Historical-data impact.** Invoices whose applied credit notes exceed what `amount_paid` records.
Read-only probe:
```sql
SELECT ci.company_id, ci.id, ci.invoice_number, ci.amount_paid,
       SUM(cn.applied_amount) AS credited
FROM customer_invoices ci
JOIN credit_notes cn ON cn.customer_invoice_id = ci.id AND cn.company_id = ci.company_id
                    AND cn.status = 'applied'
GROUP BY 1,2,3,4
HAVING SUM(cn.applied_amount) > ci.amount_paid;
```
Rows returned are invoices still showing a balance the customer has already been credited for; the
same window can also swallow a receipt, so compare against `customer_payments` allocations too.

**Risks.** `FOR UPDATE` on `customer_invoices` widens the lock held for the rest of the request
transaction; the note lock is already taken first, so the ordering rule that prevents 40P01 is
unchanged.
