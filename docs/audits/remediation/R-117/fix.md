# R-117: the ageing's settled-amount clamp erases a negative-total document

## Defect
`effectivePaidExpr` (shared/agingRewind.ts) clamped the settled amount into `[0, total_amount]`. On a negative total the bounds are inverted: `LEAST(GREATEST(0, 0), -1150)` = `-1150`. An unpaid credit-shaped document therefore reported its own total as settled, and its balance computed to exactly zero.

Found by the adversarial reviewer of R-086, where `migrationValidationService` had copied the same one-sided form.

## Reachability (checked before fixing)
- **No DB guard.** No CHECK constraint or trigger on `customer_invoices` or `supplier_invoices` restricts the sign of `total_amount` (queried on the schema fixture: 0 matching constraints).
- **Unguarded writers** (census over all 17 INSERT sites, registered as R-119): recurring-template execution, the AI capture pipeline, time-entry billing, and the Sage AR import (`=== 0`, where its AP sibling uses `> 0`). The manual create paths do guard, via `quantity > 0 / unitPrice >= 0`.
- **Where it surfaced:** the customer and supplier reports (`transactionReportingService`) SUM the expression with no balance filter. The ageing and the subledger filter `balance > 0`, so they exclude a negative document either way — with or without the defect.

## Fix
The bounds follow the total's sign: `LEAST(GREATEST(paid, LEAST(total, 0)), GREATEST(total, 0))` — `[0, total]` for a positive document, `[total, 0]` for a negative one, `0` at zero. The same form `migrationValidationService` now uses. The overpayment protection it was written for is unchanged.

## Evidence
`tests/integration/r117-aging-negative-total-clamp.int.test.ts`, real PostgreSQL.
- **RED** (`red.log`): 4 of 4 fail — both reports claim R1,150 settled on an unpaid −R1,150 document.
- **GREEN:** 4 of 4. A −500 settlement against the −1,150 credit is kept at −500; a 1,200 overpayment on a 1,150 invoice still clamps to 1,150.
- **Regression:** 41 ageing/subledger/report integration files — 38 passed, 211 tests, 0 failed tests. The 3 failing FILES fail in `beforeAll` on environment guards that predate this change (two demand `isaflow_dev`, one needs superuser); none runs its tests on this DB.
- Unit suite: 13531 passed.
- **Mutations** (`mutations.log`), all red: the old one-sided clamp, no clamp, upper bound unclamped, lower bound unclamped.

## Historical-data impact
None written. The expression is read-only. Documents that were mis-stated are found with:
```sql
SELECT company_id, count(*), sum(total_amount) FROM customer_invoices WHERE total_amount < 0 GROUP BY 1;
SELECT company_id, count(*), sum(total_amount) FROM supplier_invoices WHERE total_amount < 0 GROUP BY 1;
```
Read-only, not run against production by this session.

## Not covered
Whether a negative-total invoice should exist at all — a credit belongs in `credit_notes`. That is R-119, and it needs the rule decided before any writer is changed.
