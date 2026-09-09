# K-055 — Write-offs are never re-validated at approval

**Claim (AA H / A H18).** Multiple drafts each claim the full balance and approval
does not recheck, so an invoice can be written off more than once.

**Corrected trigger.** Accurate. No race is involved — the two calls are sequential.
Two independent gaps compound: `createWriteOff` compares the new amount only to the
invoice's CURRENT balance and ignores other pending drafts, and `approveWriteOff`
re-reads the invoice only for its VAT split, never for its balance.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)
- `writeOffService.ts:69-79` — creation validates `input.amount > balance + 0.01`
  where `balance = total_amount - amount_paid`. A draft does not move `amount_paid`,
  so the second draft sees the same balance the first did.
- `writeOffService.ts:100-107` — approval checks only `status !== 'draft'`.
- `writeOffService.ts:110-116` — the invoice re-read selects `total_amount,
  tax_amount` for the VAT recovery. It does not read `amount_paid` and does not
  compare anything.
- `writeOffService.ts:154-159` — `amount_paid = amount_paid + $amount`, unconditional.
- Compare `customerPaymentService.ts:107-120`, which DOES sum other drafts' pending
  allocations for payments. The same defence was never applied to write-offs.
- Reachability: `customer_write_offs` rows are created and approved through the AR
  write-off surface; `write_off_number` is assigned by trigger `trg_wo_number`, so
  nothing about the second draft is unusual.

## RED test
`tests/integration/k055-writeoff-approval-not-revalidated.int.test.ts` — 1 test,
**1 failed**: `expected 2300 to be less than or equal to 1150.01`. Two drafts for the
full R1,150 balance, both approved (`WO-2026-00001`, `WO-2026-00002`), `amount_paid`
reaches R2,300 on a R1,150 invoice and AR is credited R2,300. Output: `red.log`.

## Proposed minimal fix
In `approveWriteOff`, re-read `total_amount, amount_paid` inside the same statement
that locks the invoice (`SELECT … FOR UPDATE`), and throw when
`amount > total_amount - amount_paid + 0.01`. Additionally, make `createWriteOff`
subtract the sum of other draft write-offs against the same invoice, mirroring
`createCustomerPayment`'s pending-allocation subtraction.

## Historical-data impact
Over-relieved receivables and overstated bad-debt expense. Read-only detectors:

```sql
SELECT company_id, invoice_id, count(*) AS approved_write_offs, sum(amount)
FROM customer_write_offs WHERE status = 'approved'
GROUP BY company_id, invoice_id HAVING count(*) > 1;

SELECT wo.company_id, wo.invoice_id, sum(wo.amount) AS written_off, ci.total_amount
FROM customer_write_offs wo JOIN customer_invoices ci ON ci.id = wo.invoice_id
WHERE wo.status = 'approved'
GROUP BY wo.company_id, wo.invoice_id, ci.total_amount
HAVING sum(wo.amount) > ci.total_amount + 0.01;
```

## Risks
Correcting history requires reversing the surplus write-off journal and reducing
`amount_paid`, which will move a closed period's bad-debt expense and, where VAT
recovery was claimed under §22(3), a submitted VAT201. Quantify before touching
anything, and route the VAT leg past whoever signs the returns.
