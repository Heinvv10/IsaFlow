# K-085 — Stock adjustment inserts a non-existent `stock_movements.company_id`

**Claim.** `stock_movements` has no `company_id` in the committed schema, so every adjustment
fails and rolls back.

**Corrected trigger.** Accurate. `pages/api/accounting/stock-adjustments.ts:47` INSERTs
`stock_movements (company_id, product_id, …)`. `scripts/migrations/sql/244b_inventory.sql:101-119`
creates the table without `company_id` (id, product_id, warehouse_id, movement_type, quantity,
unit_cost, total_cost, reference_type, reference_id, notes, created_by, created_at) and no later
migration adds one — confirmed against the fixture schema, which mirrors production. The statement
raises 42703; `withAuth` owns the request transaction and rolls it back on the 500, so the
`stock_adjustments` row and the `products.current_stock` update are discarded with it.

**Disposition: confirmed.**

**Evidence.** RED test drove the real route handler: HTTP 500,
`column "company_id" of relation "stock_movements" does not exist` at stock-adjustments.ts:47,
0 rows in `stock_movements`, 0 in `stock_adjustments`, and `products.current_stock` still 100.
Log: `red.log`.

**Reachability.** `POST /api/accounting/stock-adjustments`, `withAuth` + CSRF + write access, any
authenticated tenant. No UI page calls it (no non-API reference in `pages/` or `src/components/`),
so the blast radius is API/integration clients — but every adjustment type fails, not just counts.

**RED test.** `tests/integration/k085-k086-stock-adjustment-movement.int.test.ts` — 3 failed / 3
(the K-086 assertions in the same file are dominated by this failure).

**Proposed minimal fix.** Two options; pick one, do not do both.
1. Drop `company_id` from the INSERT column and value lists at stock-adjustments.ts:47. Tenancy
   then rides on `product_id` (products.company_id), as `supplier_invoice_items` already does.
2. Add `company_id UUID REFERENCES companies(id)` to `stock_movements` in a new migration, plus
   an index on `(company_id, product_id)`, and keep the INSERT as written.
Option 2 is the better shape (every other movement table is tenant-scoped, and RLS coverage tests
read `company_id`), and it costs one migration. Whichever is chosen, the GET at line 18 and any
future reader must be scoped consistently.

**Historical-data impact.** None: no row was ever written. `stock_movements` is empty for every
tenant and `stock_adjustments` holds nothing from this route. Read-only check:
`SELECT count(*) FROM stock_movements;` and
`SELECT count(*) FROM stock_adjustments;` — both expected 0.

**Risks.** Fixing this activates K-086, which is currently dormant only because the transaction
rolls back. Ship the two together or a stocktake will start corrupting stock on hand.
