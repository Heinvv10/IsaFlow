# K-110 — Deleting a GL cost centre silently unassigns every employee

**Claim.** The guard covers journal lines only; `payroll_employees.cost_centre_id` is ON DELETE SET NULL.

**Disposition: confirmed.**

**Corrected trigger.** `src/modules/accounting/services/core/costCentreService.ts:82-91` counts usage only in `gl_journal_lines` (`cost_center_id`, `cc1_id`, `cc2_id`) and then deletes. GL cost centres and payroll cost centres are the same `cost_centres` table. `scripts/migrations/sql/450_cost_centres.sql:55` adds `payroll_employees.cost_centre_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL` — confirmed in the fixture as `payroll_employees_cost_centre_id_fkey ... ON DELETE SET NULL`. Deleting a centre used only by payroll therefore succeeds and nulls every assignment with no warning. `costCentreSummaryForRun:392` then reports that payroll under the unallocated bucket.

Tenants that use `payroll_employee_cost_allocations` are protected by accident: that FK is `ON DELETE RESTRICT` (`451:22`). Exposure is the single-FK path, which is what migration 450 backfilled by default.

**Evidence.** Files above via `git show origin/master:<path>`; FK definitions read from the fixture.

**RED test.** `tests/integration/k110-cost-centre-delete-unassigns.int.test.ts` — 1 failed of 1. Observed `{centreRows: 0, employeeCentre: null}` against expected `{centreRows: 1, employeeCentre: <centre>}` after `POST /api/accounting/cost-centres-action {action:'delete'}`. Log: `red.log`.

**Reachability.** Any user with write access on the cost-centres page.

**Proposed minimal fix (3-6 lines).** Extend the guard in `deleteCostCentre` before the DELETE:
```sql
SELECT count(*) FROM payroll_employees
 WHERE cost_centre_id = ${id}::UUID AND company_id = ${companyId}::UUID
```
and throw the same "Deactivate instead" error when it is non-zero. Cover `assets.cost_centre_id` and `capture_*.resolved_cost_centre_id` (both SET NULL or NO ACTION) in the same predicate, or change the FK to RESTRICT in a migration so the database enforces it.

**Historical-data impact.** Employees whose assignment was nulled cannot be recovered from `payroll_employees` alone. `payroll_employee_history` (mig 452) tracks `cost_centre_id`, but only for changes made through `assignEmployeeCostCentre`; a cascade SET NULL writes no history row. Read-only impact SQL:
```sql
SELECT company_id, count(*) FROM payroll_employees
WHERE cost_centre_id IS NULL AND cost_centre IS NOT NULL GROUP BY 1;
```
The legacy free-text `cost_centre` column is the only surviving trace. Not run against production.

**Risks.** Low. The change only refuses deletes that currently destroy data.
