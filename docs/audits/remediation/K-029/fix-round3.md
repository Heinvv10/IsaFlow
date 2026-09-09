# K-029 round 3 — the follow-up review of `cf1b5709`

**HIGH-A — the final-month true-up was unbounded.** `monthsElapsed >= life*12 - 1`
matched every month past the life, not just the last one, and nothing upstream
stops an expired asset reaching it. An asset whose life had ended with book
value still on it — what a part-migrated register is full of — was handed its
entire remaining book value as ONE month's charge on the first run after
deploy. Measured: R100 000 cost, 5-year life, bought 2015, R40 000 taken →
R60 000 in September 2026, under straight line and reducing balance alike.

The comparison is now equality, so only the life's final month trues up. Past
that the charge is zero. A write-off of the balance is a prior-period
correction under IAS 8, not a month of depreciation, so the run reports it
instead of posting it: `lifeExpiredNote` puts the undepreciated amount on the
plan row. The row still POSTS — its tax track may have life left, and skipping
it would lose that — but its policy charge is zero and the note names what is
stranded. Visible in the dry-run preview as well, since the preview is the plan.

**MEDIUM-5 — the CSV export could not execute its own fix.** It self-fetched
`/api/assets` over HTTP with the caller's cookie. That route does not exist:
there is no `pages/api/assets.ts` and no rewrite for it, so every request 404'd,
`assets` fell back to `[]` and the handler emitted a header-only CSV for every
company. It now queries `assets` directly, scoped by `company_id`, filtered to
the same in-service statuses the run uses, and builds each line through
`calculatePolicyDepreciation`. The row-to-line mapping is `buildDepreciationCsv`,
which the tests call with hand-computed rows.

**LOW-B — `assetService` shared the annual charge but not the true-up**, so in a
life's final month it returned less than the run posts. It now applies the same
equality-bounded true-up.

**LOW-C — the detail schedule trued up on the last DISPLAYED row.** The table is
capped at 30 rows, so a 40-year asset showed its whole remaining book value in
year 30 — a write-off the run never posts. The true-up now fires on the last
year of the LIFE. The builder moved to `depreciationSchedule.ts` so it can be
tested without pulling the page's layout tree, and the heading now says the
rows are annual figures before the first-month pro-rate.

## Tests

`tests/unit/assets/depreciationConsumers.test.ts` (new, 10) covers the CSV
export, the assetService true-up and the schedule builder with hand-computed
values. `farDepreciationService.test.ts` gains 8: three methods against an
expired asset, the life's own final month, and `lifeExpiredNote`. The
integration test gains an expired asset and asserts it posts no policy journal,
records a zero policy charge in the subledger, and carries the note.

84 unit and 6 integration tests pass. Five mutations — restoring `>=`,
silencing the note, reverting the export to straight line, dropping the
assetService true-up, and truing up on the displayed row — each turn a suite red.

## Historical-data impact

Bounding the true-up means an expired asset with book value left is now charged
nothing rather than everything. Scope the population before deploying:

```sql
SELECT company_id, COUNT(*),
       SUM(purchase_price - COALESCE(salvage_value,0) - COALESCE(accumulated_depreciation,0)) AS stranded
FROM assets
WHERE status IN ('available','assigned','in_maintenance')
  AND purchase_date + (useful_life_years * INTERVAL '1 year') < CURRENT_DATE
  AND COALESCE(accumulated_depreciation,0) < purchase_price - COALESCE(salvage_value,0)
GROUP BY 1;
```

Not run — production is not queried from here.

## Limits

`calculateTaxDepreciation` has no life-expiry check of its own; it charges until
accumulated tax depreciation reaches cost. That is unchanged by this fix and is
why an expired asset stays in `postable` rather than being skipped.
