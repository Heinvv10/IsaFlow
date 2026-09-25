# K-086 — a stocktake count sets stock on hand, it does not add to it

**Status:** fix-in-review. **Base:** origin/master `0ecf6d06e`. Production was not queried.

## The defect, live since K-085

`pages/api/accounting/stock-adjustments.ts` signed `count` as +1, like an `increase`. So a count of
60 against 100 on hand left **160**, and the movement was a **60-unit `adjustment_out`**. It was
dormant only while K-085 rolled every adjustment back. K-085's fix (`972870495`, #411) is in the live
release `e2a78d699`, so every `count` posted through the API since that deploy has corrupted stock.
The validation had warned about this: "do not fix K-085 alone".

**Reach:** no UI page and no MCP tool calls `/api/accounting/stock-adjustments`. The only way in is a
direct API call with a session or API token. The census below says whether anyone did.

## The fix

- The product row is read **`FOR UPDATE`**, scoped by `company_id`, before the first write. The count
  computes its correction from an on-hand figure no concurrent writer can move. The `company_id`
  predicate matters even under RLS: the `products` policy admits every company the user belongs to,
  not only the active one.
- A `count` **replaces** `current_stock`. The movement carries the correction (counted − on hand):
  `adjustment_in` or `adjustment_out` by its sign, with a positive magnitude. It is never booked as
  movement_type `count`, because `stockValuationService` treats that type as non-delta and leaves it
  out of quantity on hand. A count equal to the shelf moves nothing, so it writes no movement; the
  `stock_adjustments` row still records it.
- `validateStockAdjustment` now refuses a quantity that is not a finite number that is exactly a
  whole number of cents. The test is `Math.round(x*100)/100 === x`, with no tolerance, and it runs
  before the first write.
  - **Why a third decimal is refused:** the columns are `NUMERIC(15,2)`. Postgres rounds `1.005` to
    `1.01`, but JS float arithmetic gives `1.00`, so the stored document and the stock it set would
    disagree. That held for every adjustment type, not only `count`.
  - **Why no tolerance:** round 2 used a 1e-6 tolerance. That let `100.000000001` through, and it
    became a `0.00` movement.
  - **Why a string is refused:** a string `"NaN"` used to pass, because it is truthy and not <= 0.
    `NUMERIC` stores NaN, and Postgres ranks NaN above 0, so `CHECK (quantity > 0)` admitted it too.
    NaN would have reached stock, the movement, the adjustment and every valuation after them.
  - With exact cents guaranteed, plain arithmetic in the route is exact at the columns' scale. An
    exhaustive check of every 2-decimal value from 0 to 20 000 round-trips.
- A `count` now requires `unitCost`, as `increase` already did. Whenever `unitCost` is given, it must
  be exact cents and zero or more. A count's correction is what moves the valuation, which is costed
  on the movement. Without a cost, shrinkage would leave at R0 and its value would stay on the books.
- `increase` / `decrease` / `write_off` / `transfer` keep their delta semantics and the clamp at
  zero. The one change for them is that a sub-cent, string or NaN quantity, or a bad `unitCost`, is
  now refused (422).

The approach and both test files are ported from `c5a52e421`. That was an unpushed local branch from
2026-09-09 that K-085's separate fix overtook.

## Proof

Everything runs through the real route: `withAuth` does `SET LOCAL ROLE app_user` (`withAuth.ts:102`).
It runs against the disposable fixture.

- `tests/integration/k086-stocktake-count-movement.int.test.ts`: the headline claim.
- `tests/integration/k086-stocktake-count-adjacent.int.test.ts`: the cases around it:
  - both delta types;
  - a count above on hand, and a count equal to on hand;
  - a 3-decimal count;
  - a count racing a writer that holds the row and moves it 100 → 55;
  - a second company, and another tenant's product;
  - a user who belongs to both companies.
- The adjacent file also covers the delta types that were not exercised before: `decrease` past
  zero (the clamp) and `transfer`. It also covers the refused inputs (a third decimal, `"NaN"`, a
  string, a count with no cost), none of which may leave rows behind. And it checks the value a
  shrinkage count takes out of `getStockValuation`.
- `red.log`: on master, 5 of 10 fail. For example, `expected 160 to be 60`.
- `green.log`: every test passes, with the k107 numbering suite alongside.
- `mutations.log`: each guard, reverted alone, turns at least one test red.
  - M7 (dropping `company_id` from the lock) survived at first, because RLS refused a stranger's
    product on its own. The two-company-user case was added for it.
  - A cents-arithmetic guard survived once the validator guaranteed 2 decimals. It was redundant, so
    it was removed rather than kept as untestable code.
- `tests/integration/k107-stock-adjustment-numbering.int.test.ts`: 4 of 4 still pass.

## Census for Hein (read-only; NOT run, and must not be run by an agent)

Were any counts posted before this fix deployed? The old code has a unique signature. It booked the
COUNTED quantity as an `adjustment_out` and added the count to stock. After this fix deploys, a
correct count can also come back unfiltered, so the query keeps only rows with that signature. Set
`:k086_deployed_at` to the deploy time, or to now() if it has not deployed yet.

```sql
SELECT sa.company_id, sa.adjustment_number, sa.product_id, sa.quantity AS counted,
       sa.created_at, sm.movement_type, sm.quantity AS movement_qty, p.current_stock
  FROM stock_adjustments sa
  JOIN products p ON p.id = sa.product_id AND p.company_id = sa.company_id
  JOIN stock_movements sm
    ON sm.reference_type = 'stock_adjustment' AND sm.reference_id = sa.id
 WHERE sa.adjustment_type = 'count'
   AND sm.movement_type = 'adjustment_out'
   AND sm.quantity = sa.quantity
   AND sa.created_at < :'k086_deployed_at'
 ORDER BY sa.created_at;
```

Expect zero rows. For any row that comes back, `current_stock` was raised by `counted` when it should
have been set to it. The correction needs a human-decided count. Nothing is corrected automatically.

## Residuals (not built)

1. **A count of zero is refused.** Both `validateStockAdjustment` (`quantity > 0`) and
   `stock_adjustments.quantity CHECK (quantity > 0)` (244b_inventory.sql) reject it, so an empty shelf
   cannot be recorded as a count. Fixing it needs a migration. **Hein's call.**
2. **Two on-hand figures.** The route keeps `products.current_stock`, but `stockValuationService`
   derives quantity on hand from `stock_movements`. Wherever the two already disagree, a count makes
   `current_stock` right while the valuation stays off by the old gap. The clamp is one way they
   split: a `decrease` of 150 against 100 sets stock to 0 but books 150 out, so the movements imply
   -50. Refusing a decrease past zero instead would be Hein's call, and the refusal would have to
   come before the adjustment INSERT. All of this predates K-086.
3. **The caller sets the cost of a count's correction, and 0 is accepted.** A shrinkage count sent
   with `unitCost: 0` removes its units at R0, so their value stays in the valuation. The
   alternative is to cost outbound corrections at the product's own carrying cost, which the
   `FOR UPDATE` read could supply. That is a valuation policy, and it is Hein's call. The same holds
   for `decrease` and `write_off`, and predates K-086.
4. **`transfer` is booked as an `adjustment_out` delta**, with no destination warehouse, and
   `stock_levels` (per warehouse) is not written by this route at all. Both predate K-086.
