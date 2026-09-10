# K-053 — Aging reports include soft-deleted invoices

**Claim (AA H / A H12).** Neither the aging query nor either subledger filters the
soft-delete flag, so deleted documents keep aging.

**Corrected trigger.** Both AGING services omit `deleted_at`, and so does the AP
supplier ledger. The AR customer ledger already filters it, so "either subledger"
is half wrong. The claim also understates the window: `purgeExpiredDeletes`
(`softDeleteService.ts:256`) has **no caller** in `src/` or `pages/` — only tests —
so the advertised 5-minute undo window never expires and a soft-deleted row is
permanent.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)
- `git show origin/master:src/modules/accounting/services/ar/arAgingService.ts` — WHERE at
  lines 47-56 filters company, status, invoice_date, balance. No `deleted_at`.
- `apAgingService.ts:87-88` and `:150-152` — same omission on the AP side.
- `pages/api/accounting/reports-supplier-ledger.ts:88-92` — the supplier-ledger invoice
  leg has no `si.deleted_at` filter (the supplier NAME lookup at :70 does, which is what
  makes the omission easy to miss).
- `customerLedgerService.ts:111,176` — AR customer ledger DOES filter. Present at the
  audited SHA already (`git log 5661d6f0 -- …customerLedgerService.ts` → `fbc685a1`).
- `git grep purgeExpiredDeletes origin/master -- src pages` → no hit outside the
  definition. Only `tests/unit/services/bl80-83-tenant-isolation.test.ts` calls it.
- Reachability: `pages/api/accounting/soft-delete.ts:48` → `softDelete`, which blocks
  only `status = 'posted'` (`softDeleteService.ts:199`). Aging excludes only `'draft'`
  and `'cancelled'`. So every `approved` / `sent` / `partially_paid` / `overdue`
  invoice is both deletable and aged — the two sets overlap on the whole open book.
- Schema (fixture DB, `information_schema.columns`): `customer_invoices.deleted_at` and
  `supplier_invoices.deleted_at` both exist (mig 268).

## RED test
`tests/integration/k053-aging-includes-soft-deleted.int.test.ts` — 2 tests, **2 failed**.
AR and AP both report R1,750 where R1,000 is live and R750 is soft-deleted.
Output: `red.log`.

## Proposed minimal fix
Add `AND ci.deleted_at IS NULL` to both `getARAging` and `getARAgingDetail`
(`arAgingService.ts`), `AND si.deleted_at IS NULL` to `getAPAging` and
`getAPAgingDetail` (`apAgingService.ts`), and to the invoice leg of
`pages/api/accounting/reports-supplier-ledger.ts`. Do NOT use the
`OR deleted_at > NOW()` form the customer ledger uses — `deleted_at` is only ever
set to `NOW()`, never to a future time, so the extra disjunct buys nothing.
Separately (own change): `purgeExpiredDeletes` needs a scheduled caller, or the
undo window should stop being described as 5 minutes.

## Historical-data impact
Any soft-deleted invoice with an open balance has been in every aging report,
overdue list and provision since it was deleted. Read-only count (run on a
non-production copy or by a DBA):

```sql
SELECT 'ar' AS side, company_id, count(*), sum(total_amount - COALESCE(amount_paid,0))
FROM customer_invoices
WHERE deleted_at IS NOT NULL AND status NOT IN ('draft','cancelled')
  AND (total_amount - COALESCE(amount_paid,0)) > 0
GROUP BY company_id
UNION ALL
SELECT 'ap', company_id, count(*), sum(total_amount - COALESCE(amount_paid,0))
FROM supplier_invoices
WHERE deleted_at IS NOT NULL AND status NOT IN ('draft','cancelled')
  AND (total_amount - COALESCE(amount_paid,0)) > 0
GROUP BY company_id;
```

## Risks
Adding the filter REMOVES money from aging totals, which will not tie to a
previously published report. Quantify with the query above before deploying, and
tell the affected companies what moved. If a row was soft-deleted by mistake and
its debt is real, the filter hides a genuine receivable — the purge gap means such
rows may be years old and unrecoverable through the UI's undo.
