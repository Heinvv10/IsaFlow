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

**Limits.** Ten cost-centre columns carry no foreign key at all, so the database can never refuse a delete that strands them; the guard is the only protection and now counts the live-code ones: `supplier_invoices.cost_center_id`, `supplier_invoice_items.cost_center_id`, `gl_journal_entries.cost_center_id`, `credit_notes.cost_center_id`, `customer_payments.cost_center_id`, `supplier_payments.cost_center_id`, `supplier_purchase_orders.cost_center_id`, `expense_claim_lines.cost_centre_id`, `supplier_coding_rules.default_cost_centre_id`, `supplier_coding_history.cost_centre_id`. Two references are deliberately outside the guard: `cost_centre_gl_mappings` (FK is ON DELETE CASCADE because a mapping has no meaning without its centre) and `capture_events.resolved_cost_centre_id` (mig 463 — an unposted classification hint, so losing it re-triggers classification rather than stranding a posting). The `archive_*` tables are not counted. `costCentreService.ts` remains over the 300-line cap; see the round-2 dispositions below.

## Review round 2 dispositions (blind review of a9e8c3e7)

- **MEDIUM-1 (guard missed the FK-less columns).** Fixed. Guard extracted to `costCentreUsageGuard.ts` and widened to journal lines, journal entries, employees, employee allocations, assets, child centres, AP/AR documents and coding rules. Limits paragraph above rewritten to name the real residue.
- **MEDIUM-2 (parent delete silently reparents children).** Fixed in the same query: `cost_centres.parent_id` is counted and refused as `N child cost centre(s)`. Test: `k110-cost-centre-guard-coverage.int.test.ts`.
- **MEDIUM-3 (649 holds ACCESS EXCLUSIVE with no timeout).** Fixed. `SET LOCAL lock_timeout = '5s'` at the top of the migration, following `600_reclassification_batches.sql`. The deploy now fails fast instead of queueing every query on `payroll_employees` and `assets`.
- **LOW-1 (wrong table named).** Fixed. The column is on `capture_events`, not `captured_documents`. `validation.md` carries the same error and is left as the validator wrote it; this file is the correction.
- **LOW-2 (RED test passed with the payroll branch deleted).** Fixed. The test now asserts the 400 and, because the LOW-3 fix also maps the FK violation to a 400, asserts the counted `1 employee(s)` message that only the guard's payroll branch produces.
- **LOW-3 (guard tenant-scoped, FK is not).** Fixed. `deleteCostCentre` catches 23503 and rethrows the same "Deactivate instead" message with the uncounted wording. Test: third case in `k110-cost-centre-guard-coverage.int.test.ts`.
- **LOW-4 (no module doc entry).** Fixed. Entries added to `core/`, `reports/` and `bank/` `.claude.md`; `AGENTS.md` mirrors regenerated and `agent-docs:check` passes.
- **LOW-5 (file over the 300-line cap).** Partially addressed, deliberately. The delete logic moved into a 92-line `costCentreUsageGuard.ts`, so the widened guard did not grow the service; `costCentreService.ts` is 426 lines against 424 on master. Bringing it under 300 means splitting the GL half from the payroll half and re-pointing every caller of twenty exports — a refactor larger and riskier than either defect, and out of scope for a defect fix. Recorded as still open.
