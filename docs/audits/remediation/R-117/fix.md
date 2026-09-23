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

## Review round 1 (adversarial reviewer), all findings fixed

The reviewer proved in SQL that for `total_amount >= 0` the new form is bit-identical to the old across every shape, and that `total_amount` is NOT NULL on both tables, so the blast radius is exactly the negative case. The objections were to the test.

| Finding | Fix | Proof |
|---|---|---|
| HIGH: the test file had no production-DB guard. It INSERTs and DELETEs against whatever `DATABASE_URL` names — 26 sibling suites call a guard, this one did not. | `assertDisposable()`, which requires the localhost fixture database by name (stricter than `assertNotProductionDb`, which only allows `isaflow_dev`/`isaflow_test`). | The file refuses to run against anything else. |
| MEDIUM: no case where `amount_paid` is more negative than the total, so dropping the lower clamp stayed green. | Truth-table cases: −500 → −500, −1150 → −1150, −2000 → −1150, +500 → 0, each on its own document and customer. | Mutation M5 (lower clamp dropped) now red. |
| MEDIUM: two further unfiltered SUM sites — the `sales-by-customer` and `purchases-by-supplier` routes — were neither documented nor covered. | Named in the expression's comment and in the test header; a case drives the real `sales-by-customer` handler through `withAuth` and asserts Received 0 / Outstanding −1150. | The route case is red under M1 and M6. |
| LOW: a wrong-signed settlement (+500 on a −1150 document) now reports 0, discarding a figure the books contain. | Pinned as a test case and documented in the expression: the clamp cannot repair a data defect; surfacing it is registered on R-119. | — |
| LOW: case 3 mutated and restored `amount_paid`, so case 4 depended on that restore. | Every case now seeds its own document and customer. | — |

Two traps hit while fixing this, both caught by running the suite rather than reasoning: `users.id` is VARCHAR, so `${USER}::UUID` in teardown raised 42883 and the FILE failed while all 8 tests passed; and the route's response is `data: [...]` with camelCase keys, not `data.rows` with snake_case.

Mutations, round 2 (`mutations.log`): old one-sided clamp → 6 red; lower clamp dropped → 1 red; upper bound unclamped → 6 red.

## Review round 2 — SHIP, with both residuals closed
The reviewer confirmed the guard is the repo's dominant convention (192 files call `assertDisposable` at top level), replicated `sales-by-customer`'s aggregate in psql to prove the route case is red on master (`received_old -1150 / outstanding_old 0` versus `received_new 0 / outstanding_new -1150`), and raised two non-blocking residuals, both now closed:
- `purchases-by-supplier` was named but not exercised. It has its own case; the shared `callReport` helper drives both routes through `withAuth`. Both go red under the old clamp.
- The branch was 7 commits behind master, so the CI gate would not have run against current master. Rebased.
