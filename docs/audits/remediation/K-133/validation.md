# K-133 — three-way match's caught UPDATE failure aborts the request

**Claim.** `supplierInvoiceWorkflowService.ts:408` catches a failed UPDATE without a
savepoint, so the shared transaction is already dead.

**Corrected trigger — the claim is right about the code and wrong about the order.**
Two defects sit on the same function; the second hides the first.

1. `performThreeWayMatch` loads the PO lines with
   `SELECT * FROM po_items WHERE purchase_order_id = … AND company_id = …`
   (origin/master line 388) and the GRN lines the same way (line 396). Neither
   `po_items` nor `grn_items` HAS a `company_id` column on the live schema. So the
   function raises 42703 undefined_column on every bill that has a linked purchase
   order — three-way match is dead for all tenants, and it aborts the caller's
   transaction from there. It never reaches line 408.
2. The claimed defect is nonetheless real in the code: the per-line UPDATE at 404-420
   is wrapped in a bare try/catch with no savepoint. `sql` routes through the request
   transaction (`src/lib/neon.ts` `LazyQuery#run`), so a failure there leaves the
   connection aborted and the catch hides the cause. The file already imports
   `withSavepoint` for exactly this pattern. A concrete trigger exists once (1) is
   fixed: `qty_variance_pct` and `price_variance_pct` are `numeric(6,2)` (max 9999.99)
   and the service computes `(invoiceQty - poQty) / max(poQty,1) * 100`, so a bill for
   200 units against a PO for 1 "lot" is 19900.00% and raises 22003.

**Disposition: confirmed**, with the corrected ordering above. Fixing (2) alone changes
nothing observable; fixing (1) alone arms (2).

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts:386-420`.
- Schema: `po_items` columns are id, purchase_order_id, product_id, description,
  quantity, unit_price, tax_rate, line_total, tax_amount, quantity_received,
  quantity_invoiced, gl_account_id, sort_order, created_at. No company_id. Same for
  `grn_items`. Only migration `246b_purchase_orders.sql` touches the table; nothing
  adds the column later.
- Executed RED test: `performThreeWayMatch` throws `42703 column "company_id" does not
  exist`, and the surrounding request transaction is then `25P02`.

**Reachability.** `performThreeWayMatch` is re-exported from `supplierInvoiceService`
and reachable from the AP three-way-match action for any bill with a
`purchase_order_id`. A bill without one early-returns `unmatched` and is unaffected —
which is why this has stayed hidden.

**RED test.** `tests/integration/k133-three-way-match-poisons-transaction.int.test.ts`
(1 test, 1 failed) — output in `red.log`.

**Proposed minimal fix.** (a) Drop `AND company_id = …` from both the `po_items` and
`grn_items` queries and scope through the parent instead — join `purchase_orders`
(and `goods_received_notes`) on `company_id`, the way the item UPDATE already scopes
through `supplier_invoices`. (b) Wrap the per-line UPDATE in
`withSavepoint('3wm_line', …)` so a rejected line does not abort the request. (c) Clamp
or widen the variance columns — clamping in the service is the smaller change.

**Historical-data impact.** `supplier_invoices.match_status` has never been advanced by
this function for any PO-linked bill. Read-only impact query (NOT run — production out
of scope):

```sql
SELECT company_id, COUNT(*) FROM supplier_invoices
WHERE purchase_order_id IS NOT NULL AND match_status = 'unmatched'
GROUP BY company_id;
```

**Risks.** Fixing (a) without (b) and (c) turns a 42703 into a 22003 for extreme
variances — the same 500, a different code. Land all three together.
