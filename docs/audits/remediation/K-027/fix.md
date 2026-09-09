# K-027 fix — depreciation carries forward accumulated tax depreciation

Three commits: `71c70ece` (the carry-forward), `762b8cc4` (six findings from a
blind review of it), and this one, which closes the two the re-review found
still open. Read them together.

**Trigger.** Every depreciation run, from the second period onwards.
`loadDepreciationAssets` (`depreciationRunPlan.ts`) reads the tax opening
balance from `assets.tax_accumulated_depreciation`, and no code path wrote it.
`postDualDepreciationToLedger` wrote back only `accumulated_depreciation` and
`current_book_value`.

**Before.** Every period opened at the seeded tax accumulated depreciation
(normally 0). `asset_period_ledger.tax_closing_acc_dep` never accumulated,
`tax_carrying_amount` stayed at cost minus one period, and `deferred_tax` was
computed off that wrong carrying amount.

**After.** Inside the existing per-asset savepoint, before anything is computed,
the run takes `SELECT ... FOR UPDATE` on the asset row (5s `lock_timeout`), then
derives the period's tax opening balance from the SUBLEDGER — the base carried
by the earliest `asset_period_ledger` row, plus every charge in a period before
this one. After the ledger upsert it sets `assets.tax_accumulated_depreciation`
and `tax_book_value` from the subledger TOTAL: every other period's charge plus
this one's. All of it scoped by `company_id`.

`assets.tax_accumulated_depreciation` is a CACHE of the subledger, and the two
rules follow from that. Reading the OPENING from the column was wrong because
`period_date` is caller-supplied on both the REST route and the MCP tool, so a
back-posted period opened on a newer balance and its charge never reached the
accumulation — posting February, then January, then March left the asset at
4 000 against 6 000 charged. And the read had to be serialised: nothing else
orders two `run_depreciation` calls, and re-reading inside the transaction does
NOT help, because the subquery runs under the reader's own snapshot and cannot
see a row the other transaction has not committed. Two sessions both read the
same opening and the later commit dropped the earlier period's charge.

The plan additionally skips an asset that already holds an
`asset_period_ledger` row for the period, under its own reason
`already_in_subledger`. The pre-existing `already_posted` guard keys on the
JOURNAL, and no journal is written when the policy charge is zero — which is
ordinary, since the policy base is `cost * (1 - residualPct)` against a tax base
of full cost, so any asset with a residual or a longer tax life ends its life at
policy 0 with tax still running. Without the second key such an asset stayed
postable for ever and every re-run doubled the tax column and rewrote the
subledger row to two months of wear in one calendar month.

**Files.**
- `src/modules/accounting/services/gl/assetTaxAccumulation.ts` — NEW. The locked
  read and the clamped write, with the reasoning for both. Listed in the
  module's `.claude.md`; `AGENTS.md` mirror regenerated.
- `src/modules/accounting/services/gl/assetDepreciationPosting.ts` (269 lines)
- `src/modules/accounting/services/items/depreciationRunPlan.ts` (300 lines)
- `src/lib/mcp/tools/writeDepreciation.ts` — the `run_depreciation` description
  claimed re-runs were safe "by entry number", which was the false half.

**Tests.** 12 passing against real Postgres, in two files.
- `tests/integration/k027-tax-depreciation-carry-forward.int.test.ts` (6): two
  consecutive periods open and close correctly; re-posting a period with a
  journal does not double; a dry run writes nothing; a second company is
  untouched; journal counts asserted at each step.
- `tests/integration/k027-tax-depreciation-idempotency.int.test.ts` (5): an
  asset at policy 0 with tax still running posts tax and NO journal; re-running
  that period changes nothing (`already_in_subledger`, subledger row still one
  month); back-posting January after February keeps BOTH charges and opens
  January at 0; March then opens on the subledger total and the asset equals
  every charge made; and two concurrent sessions, driven through
  `lockAssetTaxBase` / `writeAssetTaxAccumulation` on separate clients, both
  keep their charge — the second blocks on the row lock rather than reading
  past the first; and a subledger that over-charged (70 periods of 2 000 against
  a 120 000 cost) caps the cache at cost with a book value of zero rather than
  -20 000.

`tests/unit/services/dualDepreciationAtomicity.test.ts` was updated in the same
direction: it pinned the ledger upsert as the FIRST statement in the savepoint,
and now asserts that the row lock precedes it.

Mutation checks, all recorded in `green.log`: reverting the first commit's
change turns 4 of the first file's 6 red; reverting to `71c70ece` turns 3 of the
second file's red; reverting the posting file to `762b8cc4` turns both
back-posting tests red at 2 000 where 4 000 is correct; deleting only the
`FOR UPDATE` line turns the concurrency test red; and removing the clamp turns
the over-charge test red at 140 000 where 120 000 is the bound.

**Migration / rollback.** None. Rollback is reverting all three commits.

**Historical-data impact.** Wide, and NOT corrected here. For every company that
has run depreciation more than once: `assets.tax_accumulated_depreciation` and
`tax_book_value` are stale; every `asset_period_ledger` row after the first
understates `tax_closing_acc_dep` and overstates `tax_carrying_amount`, so
`deferred_tax` is wrong on each; `pages/api/accounting/assets/[assetId]/dispose.ts`
read a nil tax accumulated depreciation for every disposal recapture to date;
the FAR report (`far-report.ts`) prints the ledger, so its tax column is wrong.

The detection query must compare each period's opening against the previous
period's closing, NOT look for a zero asset column. A zero column stops being
the symptom the moment this fix runs once: the first post-fix run writes a
plausible non-zero figure that is still wrong by every earlier period. This
query stays valid before and after deployment (syntax-checked on the disposable
fixture; NOT run against production):

```sql
WITH ordered AS (
  SELECT company_id, asset_id, yyyymm, tax_opening_acc_dep,
         LAG(tax_closing_acc_dep) OVER (
           PARTITION BY company_id, asset_id ORDER BY yyyymm) AS prior_closing
  FROM asset_period_ledger
)
SELECT company_id,
       count(DISTINCT asset_id) AS assets_with_broken_carry_forward,
       count(*)                 AS broken_period_rows,
       min(yyyymm)              AS first_broken_period,
       max(abs(tax_opening_acc_dep - prior_closing)) AS worst_gap
FROM ordered
WHERE prior_closing IS NOT NULL
  AND abs(tax_opening_acc_dep - prior_closing) > 0.005
GROUP BY 1 ORDER BY 2 DESC;
```

And, for the asset columns against the latest subledger row:

```sql
SELECT a.company_id, count(*) AS assets_disagreeing_with_subledger
FROM assets a
JOIN LATERAL (
  SELECT tax_closing_acc_dep FROM asset_period_ledger l
  WHERE l.company_id = a.company_id AND l.asset_id = a.id
  ORDER BY l.yyyymm DESC LIMIT 1
) l ON true
WHERE abs(COALESCE(a.tax_accumulated_depreciation, 0) - l.tax_closing_acc_dep) > 0.005
GROUP BY 1 ORDER BY 2 DESC;
```

**What a backfill would need (not written — deliberately out of scope).** Not a
single UPDATE. Each period's tax depreciation depends on the previous closing
balance and is capped by the remaining tax base, so the repair must walk
`asset_period_ledger` per asset in `yyyymm` order, re-running
`calculateTaxDepreciation` with the recomputed opening for each row, rewriting
`tax_opening_acc_dep` / `tax_current_dep` / `tax_closing_acc_dep` /
`tax_carrying_amount` / `deferred_tax`, and only then setting the two asset
columns from the last row. Company-scoped per statement, and idempotent.
Deferred-tax movements already posted to the GL, and disposal recapture already
computed from the nil balance, need separate review before any figures move.

**Limits.**
- No existing subledger ROW is repaired by any of these commits, but the
  going-forward accumulation SELF-HEALS. The opening is now
  `base + sum(charges before this period)`, and every K-027-damaged row carries a
  correct `tax_current_dep`, so the first post-fix run recovers the true
  accumulation without a backfill. Measured on three seeded rows each reading
  opening 0 / closing 2 000 with the asset column at 0: the next run opened at
  6 000, charged 2 000, closed at 8 000 and set the asset to 8 000. The ordered
  backfill below is therefore needed only to restate historical REPORT rows, not
  to correct the balance the next run will produce.
- Where the damaged history over-charged — pre-fix, the opening never
  accumulated, so `remaining = cost - opening` never fell to zero and a full
  month was charged for every period run — the cached figures are clamped to
  cost and floored at zero, with a `log.warn` naming the asset and both
  amounts. Unclamped it wrote a negative `tax_book_value` (-20 000 on a 120 000
  asset with 70 charged periods) into the FAR report, and gave `dispose.ts` an
  accumulation larger than the asset ever cost to compute recoupment from. The
  clamp bounds the cache; it does not repair the subledger rows that caused it,
  which is what the warning is for.
- A clamped asset therefore stays flagged, BY DESIGN, in two places. It appears
  in the `assets_disagreeing_with_subledger` query below for good — 120 000 will
  never equal the 140 000 its corrupt history closed at — so an operator running
  that query after deployment must read a clamped asset as a subledger still
  needing repair, not as an unfixed write-back. And it re-warns on every
  subsequent run, because `writeAssetTaxAccumulation` is called each period and
  the history never shrinks. The recurring warning IS the outstanding signal;
  it stops when the subledger rows are recomputed, not before.
- The clamp bounds the cache only, never the next opening. `lockAssetTaxBase`
  derives the opening from unclamped subledger sums, so an over-charged asset
  still computes `remaining <= 0` and correctly charges nothing further.
- `DualDepInput` carries no tax opening. The field existed, was passed
  `Number(a.tax_acc_dep)` by the run, and after the opening moved to the
  subledger nothing read it — a field written but never read, the mirror of the
  column read but never written that this ticket began with. It and the SELECT
  alias feeding it are gone, so a future caller cannot supply an opening and
  reasonably expect it to decide anything.
- A back-posted period does not RECOMPUTE the subledger rows that were written
  after it. Posting February, then January, then March now leaves the asset at
  6 000, equal to the three charges made, and March opening at 4 000 — both
  correct. But February's stored row still reads opening 0 / closing 2 000,
  computed when it was the only period. Repairing it means recomputing every
  later row, which is the ordered backfill above. The `worst_gap` query detects
  exactly this.
- Assets seeded with a non-zero `tax_opening_acc_dep` at import still ignore
  that column. The base now comes from the earliest subledger row's own
  opening, and on a first run from `tax_accumulated_depreciation`. Unchanged
  behaviour for `tax_opening_acc_dep` itself.
- The lock is per ASSET, taken inside the per-asset savepoint, and is held to
  the end of the request transaction. Two runs over the same register still
  interleave asset by asset; what is guaranteed is that no asset's accumulation
  is computed from a balance another session is concurrently changing. A run
  that cannot take the lock within 5s fails that asset loudly as `glFailed`
  rather than proceeding on a stale read.
- The policy ASSET COLUMN is untouched by these commits and was never subject to
  either defect: its write-back is an in-SQL increment on the locked row. The
  policy columns IN `asset_period_ledger` still are subject to both, because
  `policy_opening_acc_dep` still comes from the pre-transaction snapshot.
  Measured: back-posting February, January, March stores policy openings of
  1 000 / 0 / 2 000, non-monotonic in the same way the tax side used to be; two
  concurrent periods both store opening 0 / closing 1 000 while the asset column
  correctly holds 2 000. `deferred_tax` is computed from
  `policyCarryingAmount`, so it inherits the error on those rows. Pre-existing
  and out of scope for K-027 — the same remedy applies, and the fix is to route
  the policy opening through `assetTaxAccumulation.ts` the way the tax side now
  is.
