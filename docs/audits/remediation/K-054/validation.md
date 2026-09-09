# K-054 — confirmCustomerPayment: unlocked read, unguarded status flip

**Claim (AA H / A H15).** `confirmCustomerPayment` takes no row lock and its status
flip is unguarded; concurrent confirmations both pass the status check and allocate
the same receipt twice.

**Corrected trigger.** Accurate as written. Both halves are needed: the read has no
`FOR UPDATE`, AND the terminal `UPDATE customer_payments` carries no `status = 'draft'`
predicate, so nothing detects that the row moved under it.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)
- `customerPaymentAllocationService.ts:38-40` — `getCustomerPaymentById(...)` then
  `if (payment.status !== 'draft') throw`.
- `customerPaymentService.ts:81-85` — that getter is a plain `SELECT cp.*`, no lock.
- `customerPaymentAllocationService.ts:82-87` — `UPDATE customer_payments SET
  status = 'confirmed' … WHERE id = $1 AND company_id = $2`. No status predicate,
  no `RETURNING`-count check.
- Contrast `cancelWriteOff` (`writeOffService.ts:171`), which does carry
  `AND status = 'draft'` and raises when nothing is returned. The pattern exists in
  the codebase; this path does not use it.
- `createCustomerPayment` (`customerPaymentService.ts:107-120`) already sums OTHER
  drafts' pending allocations, so the creation-time over-allocation is closed. The
  confirm-time race is not.

## RED test
`tests/integration/k054-confirm-payment-double-allocate.int.test.ts` — 1 test,
**1 failed**: `expected 2300 to be close to 1150`. Two request transactions, both
open; the second call is issued only after the first has posted and the first commits
only once the second is provably waiting on a lock (`pg_stat_activity.wait_event_type`).
Nothing is timing-dependent. `red.log` shows TWO "Confirmed customer payment" lines
and two journals (`JE-2026-00001`, `JE-2026-00002`) for one receipt.
Result: invoice credited R2,300 for R1,150 received; bank debited twice.

## Proposed minimal fix
In `confirmCustomerPayment`, before the guard, take the row:
`SELECT status FROM customer_payments WHERE id = $1 AND company_id = $2 FOR UPDATE`
(with a `lock_timeout`, as `bankTxLock.ts` does), and change the terminal update to
`… WHERE id = $1 AND company_id = $2 AND status = 'draft' RETURNING *`, throwing when
it returns no row. Apply the same to `cancelCustomerPayment`, whose
`status !== 'confirmed'` guard has the identical shape, and check the AP mirror
(`supplierPaymentService`) before closing.

## Historical-data impact
A double-confirm leaves two `auto_payment` journals with the same description and
date for one payment, and `amount_paid` above what was received. Read-only detector:

```sql
SELECT je.company_id, je.description, count(*) AS journals
FROM gl_journal_entries je
WHERE je.source = 'auto_payment' AND je.description LIKE 'Customer payment %'
  AND je.status = 'posted'
GROUP BY je.company_id, je.description HAVING count(*) > 1;

SELECT company_id, id, invoice_number, total_amount, amount_paid
FROM customer_invoices
WHERE amount_paid > total_amount + 0.01;
```

## Risks
The fix serialises confirmations of the same receipt, so a UI that fires two
requests will now surface an error where it previously succeeded twice — that is the
point, but it is a user-visible behaviour change. Correcting historical rows means
reversing one of the duplicate journals AND reducing `amount_paid`; per
`feedback_payment_journal_is_the_bank_leg`, deleting the journal moves the bank GL,
so reverse rather than delete.
