# K-117 — unapplied-receipts report counts draft payments as cash

**Claim.** Draft receipts are included in the unapplied figure, overstating cash awaiting allocation.

**Corrected trigger.** `<> 'cancelled'` admits `reconciled` as well as `draft`. `reconciled` is a
posted receipt and belongs in the figure; `draft` is not posted and does not. Only the draft half is
a defect.

**Disposition: confirmed.**

## Evidence
- Baseline `origin/master` = `31fc2f10`; `git diff HEAD origin/master -- unappliedReceiptService.ts`
  is empty, so the checked-out copy the test exercises is byte-identical to the baseline.
- `unappliedReceiptService.ts:160`, `:196`, `:227` — all three queries filter `cp.status <> 'cancelled'`.
- Fixture schema: `customer_payments_status_check` permits `draft | confirmed | reconciled | cancelled`,
  so `<> 'cancelled'` lets drafts through.
- RED: `tests/integration/k117-unapplied-counts-draft-receipts.int.test.ts` — 1 test, 1 failed.
  One confirmed R100,000 receipt plus one draft R250,000 receipt reports `totalUnapplied` R350,000.
  Log: `red.log`.

## Reachability
The unapplied-receipts report endpoint and the MCP tool that reads it. Read-only.

## Proposed minimal fix
`src/modules/accounting/services/ar/unappliedReceiptService.ts`
1. Replace `cp.status <> 'cancelled'` with `cp.status = ANY(ARRAY['confirmed','reconciled'])` in all
   three queries (`:160`, `:196`, `:227`), so the predicate names what it includes rather than what it
   excludes and a new status cannot silently join the figure.
2. Apply the same change to `unappliedReceiptOrigin.ts:100`, which shares the population — see K-118.
3. State the exclusion in the result envelope so a reader can reconcile against a draft-inclusive
   total if they want one.

## Historical-data impact
None to stored rows; the report writes nothing. Every historical run over a book holding draft
receipts overstated unapplied cash by their unallocated total. Read-only sizing (NOT run against
production):
```sql
SELECT company_id, COUNT(*), SUM(cp.total_amount - COALESCE(a.allocated, 0)) AS overstated
FROM customer_payments cp
LEFT JOIN LATERAL (SELECT SUM(amount_allocated) AS allocated
                   FROM customer_payment_allocations WHERE payment_id = cp.id) a ON TRUE
WHERE cp.status = 'draft' AND (cp.total_amount - COALESCE(a.allocated, 0)) > 0.01
GROUP BY 1;
```

## Risks
The figure will DROP after the fix, on a report whose whole purpose is explaining a reconciling
difference. Whoever runs it needs telling, or the drop reads as data loss.
