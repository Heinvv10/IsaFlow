# K-110 fix — deleting a cost centre no longer unassigns employees or assets

**Trigger.** `deleteCostCentre` counted usage in `gl_journal_lines` only. `payroll_employees.cost_centre_id` (mig 450) and `assets.cost_centre_id` (mig 361) were `ON DELETE SET NULL` / no action, so deleting a centre that only payroll or assets referenced succeeded and nulled every assignment with no warning and no history row.

**Before.** POST `/api/accounting/cost-centres-action {action:'delete'}` on a payroll-only centre returned 200; the centre vanished and `payroll_employees.cost_centre_id` became NULL.
**After.** The guard counts journal lines, employees and assets in one query and throws `Cannot delete cost centre that is used by N employee(s), M asset(s). Deactivate instead.` (400). Migration 649 makes both FKs `ON DELETE RESTRICT` so the database refuses the delete even if the guard is bypassed. Deleting an unused centre still works.

**Files.** `src/modules/accounting/services/core/costCentreService.ts`, `scripts/migrations/sql/649_cost_centre_delete_restrict.sql`.

**Tests.** `tests/integration/k110-cost-centre-delete-unassigns.int.test.ts` (1) and `tests/integration/k110-cost-centre-delete-adjacent.int.test.ts` (4): asset-only refusal with the counted message, unused centre still deletable, second tenant untouched, and a raw `DELETE` refused by the FK with 23503. Mutation proof in `green.log` covers the guard and the migration independently.

**Migration.** 649, renumbered from the reserved 634 after that prefix was taken by a forensic branch. `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`, so it is re-runnable. Rollback: re-run the ALTERs with `ON DELETE SET NULL`.

**Historical-data impact.** Assignments already nulled are unrecoverable from `payroll_employees`; a cascade SET NULL writes no `payroll_employee_history` row, so the legacy free-text `cost_centre` column is the only surviving trace. Read-only impact SQL (not run against production):
```sql
SELECT company_id, count(*) FROM payroll_employees
WHERE cost_centre_id IS NULL AND cost_centre IS NOT NULL GROUP BY 1;
SELECT company_id, count(*) FROM assets WHERE cost_centre_id IS NULL GROUP BY 1;
```

**Limits.** `captured_documents.resolved_cost_centre_id` (mig 463) is still `ON DELETE SET NULL` and is not in the guard. It holds a suggested classification on an unposted capture, not a posted allocation, so losing it re-triggers classification rather than corrupting a ledger. Left out deliberately to keep the change minimal; note it if capture output is ever treated as authoritative.
