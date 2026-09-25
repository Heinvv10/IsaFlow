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
- The arithmetic is done in cents. The columns are `NUMERIC(15,2)`. Rounding the count and the
  correction separately let stock + correction drift a cent off the previous on-hand.
- `increase` / `decrease` / `write_off` / `transfer` are unchanged: they are deltas and keep the clamp.

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
- `red.log`: on master, 5 of 10 fail. For example, `expected 160 to be 60`.
- `green.log`: 12 of 12 pass.
- `mutations.log`: each of the 7 guards, reverted alone, turns at least one test red. M7 (dropping
  `company_id` from the lock) first survived, because RLS refused a stranger's product on its own. The
  two-company-user case was added for it and now fails under M7.
- `tests/integration/k107-stock-adjustment-numbering.int.test.ts`: 4 of 4 still pass.

## Census for Hein (read-only; NOT run, and must not be run by an agent)

Were any counts posted since the K-085 fix went live? If so, their stock is wrong by roughly the full
on-hand.

```sql
SELECT sa.company_id, sa.adjustment_number, sa.product_id, sa.quantity AS counted,
       sa.created_at, sm.movement_type, sm.quantity AS movement_qty, p.current_stock
  FROM stock_adjustments sa
  JOIN products p ON p.id = sa.product_id AND p.company_id = sa.company_id
  LEFT JOIN stock_movements sm
         ON sm.reference_type = 'stock_adjustment' AND sm.reference_id = sa.id
 WHERE sa.adjustment_type = 'count'
 ORDER BY sa.created_at;
```

Expect zero rows. Any row that comes back needs a human-decided correcting count. Nothing is corrected
automatically.

## Residuals (not built)

1. **A count of zero is refused.** Both `validateStockAdjustment` (`quantity > 0`) and
   `stock_adjustments.quantity CHECK (quantity > 0)` (244b_inventory.sql) reject it, so an empty shelf
   cannot be recorded as a count. Fixing it needs a migration. **Hein's call.**
2. **Two on-hand figures.** The route keeps `products.current_stock`, but `stockValuationService`
   derives quantity on hand from `stock_movements`. Wherever the two already disagree, a count makes
   `current_stock` right while the valuation stays off by the old gap. This predates K-086.
3. **`transfer` is booked as an `adjustment_out` delta**, with no destination warehouse, and
   `stock_levels` (per warehouse) is not written by this route at all. Both predate K-086.
