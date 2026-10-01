# K-086 — Stocktake count applied as a delta

**Claim.** The counted quantity is added to stock instead of replacing it, and recorded as an
outbound movement.

**Corrected trigger.** Accurate on the code, dormant in effect. At
`pages/api/accounting/stock-adjustments.ts:41`,
`const sign = ['increase', 'count'].includes(body.adjustmentType) ? 1 : -1`, so a `count` is
applied as `current_stock + quantity` (line 42). Line 46 then maps `count` to `adjustment_out`
and line 47 writes the counted quantity as the movement quantity. A count of 60 against 100 on
hand should leave 60 and record a 40-unit correction; the code leaves 160 and records a 60-unit
outbound movement. It never reaches the database today because the same request dies at K-085 and
`withAuth` rolls the transaction back.

**Disposition: confirmed, latent — blocked behind K-085.**

**Evidence.** RED test: after a `count` of 60 against an on-hand of 100, `products.current_stock`
was still 100 (rollback) and `stock_movements` was empty. Both K-086 assertions fail, but for
K-085's reason on today's code — they become true failures of the delta logic the moment K-085 is
fixed. Log: `red.log`. Code read with `git show origin/master:pages/api/accounting/stock-adjustments.ts`.

**Reachability.** Same route as K-085; unreachable in effect until K-085 lands. This is the
"a fix activates a dormant defect" shape — do not fix K-085 alone.

**RED test.** `tests/integration/k085-k086-stock-adjustment-movement.int.test.ts` — 3 failed / 3
(assertions 2 and 3 are K-086's).

**Proposed minimal fix.** Treat `count` as an absolute: read the product's `current_stock` inside
the same transaction (`SELECT … FOR UPDATE`), compute `delta = counted − onHand`, set
`current_stock = counted`, and write the movement with `abs(delta)` and a `movement_type` chosen
from the delta's sign (`'count'` is already permitted by the CHECK in 244b_inventory.sql:106-110).
Leave `increase`/`decrease`/`write_off` on the existing delta path.

**Historical-data impact.** None: K-085 means no adjustment has ever committed. Confirm with
`SELECT count(*) FROM stock_adjustments WHERE adjustment_type = 'count';` — expected 0.

**Risks.** A count that lowers stock must not be blocked by the `GREATEST(0, …)` clamp on line 42;
the clamp hides a negative result rather than reporting it.
