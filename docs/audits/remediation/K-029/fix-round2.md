# K-029 round 2 — every finding from the blind review of `01b56039`

**HIGH-1 — reducing balance never reached the residual and posted forever.**
`carrying x 2 / life` is a geometric series; it only approaches the residual.
Measured, R100 000 / 5 years / no residual: 86 920.09 charged over the life,
13 079.91 still on the books, and a shrinking DEP-* journal every month after.
`decliningYearCharge` now takes the standard crossover — the greater of the
declining charge and the remaining depreciable amount spread over the remaining
life — so the schedule lands exactly on the residual at the end of the life.
Six new tests run every method month by month for the life plus two years and
assert the total equals the depreciable amount and that no journal follows.

**MEDIUM-2 — the declining rate was compounded monthly.** The charge was derived
from the running accumulated balance, so twelve monthly runs charged 33 423.51
against a stated 40% rate. `annualPolicyCharge` is now keyed on `monthsElapsed`
alone and never reads accumulated depreciation, so all twelve months of a year
carry the year-opening carrying amount. Year 1 charges exactly 40 000.

**MEDIUM-3 — sum-of-years stranded the pro-rated first month** (1 254.40 on the
register forever). The final month of the life now trues the schedule up to the
remaining depreciable amount, under every method.

**MEDIUM-4/5/6 — one schedule, four consumers.** `assetService`'s
`calculateStraightLine` / `calculateReducingBalance` / `calculateSumOfYears` now
delegate to `annualPolicyCharge` instead of implementing the methods a second
time (they disagreed: 4 166.67 against 4 761.90 for a 2.5-year life). The
depreciation CSV export (`depreciation-export.ts`) and the asset detail page's
schedule (`[assetId].tsx`), both hard-coded to straight line, now read the same
calculator. An integration test asserts the run's posted charge equals what
`calculateDepreciation` returns for the same asset.

**LOW-7 — the category fold.** Kept, documented as defensive, and the false
claim withdrawn: `assets.depreciation_method` is NOT NULL DEFAULT
'straight_line', so the method cannot inherit from `asset_categories` the way
useful life, residual and tax life do — the asset row always carries the
default, and inheriting would silently convert genuine straight-line assets.
Making it inherit needs a nullable column and is a schema decision, not part of
this fix. Recorded as a limit.

**LOW-8 — `policy_dep_rate` on a repost.** The `ON CONFLICT DO UPDATE` now
refreshes `policy_dep_rate` and `policy_opening_acc_dep`; an integration test
reposts a period and asserts the rate moves from 14.4% to 40%.

**LOW-9 — limits.** All three arithmetic defects are now fixed rather than
disclosed; the remaining limits are in `fix.md`.

## Tests changed rather than added

Two tests asserted the behaviour the review calls wrong, so they could not have
caught it. `depreciation-calc.test.ts` "reduces as book value decreases"
compared two months inside one year and now compares two years, plus pins the
within-year constancy. `farDepreciationService.test.ts` "charges nothing under
sum-of-years once the life has run out" pinned the stranded pro-rate and is
replaced by the full-life exactness tests. The headline reducing-balance figure
in the integration test moves from 2 666.67 to 1 200.00 for the same asset:
2 666.67 was the compounded number MEDIUM-2 rejects, and 1 200.00 is year 3 of
the corrected schedule. It is still not the 1 666.67 straight line would charge,
so the original defect stays pinned.
