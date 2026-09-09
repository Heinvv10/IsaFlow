# K-025 — once-off payroll batches no longer recur
**Trigger.** `postBatch` copied the batch line's `effective_to` verbatim. Neither the API schema nor the UI ever supplies one, and `getEmployeeComponents` filters on the date window only, so a once-off batch wrote an open-ended assignment that `calculatePayrollRun` paid again every period, indefinitely.
**Before/after.** Before: `is_recurring = false` batch → `effective_to = NULL` → paid every month. After: `postBatch` closes the assignment at the last day of the batch's own period (`Date.UTC(periodYear, periodMonth, 0)`). Recurring batches stay open-ended; an explicit line `effective_to` is preserved; a close date earlier than `effective_from` is clamped so the range is never inverted.
**Reader left alone.** `getEmployeeComponents` still ignores `is_recurring`. Adding that filter would retroactively stop every existing open-ended once-off row from paying — a change to declared payroll, not a code fix.
**Files.** `src/modules/accounting/services/payroll/payrollBatchService.ts` (+15/-3: `closeOnceOffAt`, applied in both the `component_values` and `reimbursive_travel` arms). `tests/unit/services/payroll/payrollBatchService.test.ts` (+4: two `postBatch` mock batch rows omitted the NOT NULL `period_year`/`period_month`).
**Tests.** `tests/integration/k025-once-off-batch-recurs.int.test.ts` — 10 tests, real Postgres, real service calls: closed at period end; paid in its own period; not the next; not a year later; recurring unchanged and still paying; explicit `effective_to` kept; both travel rows (3702/3703) closed; no inverted range; second tenant unaffected and cross-tenant reads empty; R-006 still reproduces. Mutation check: reverting the production change turns 7 of 10 red.
**Migration/rollback.** None. Revert the commit.
**R-006 (not fixed; confirmed still reproducing).** The UI defaults a line's `effectiveFrom` to the LAST day of the batch period while `calculatePayrollRun` evaluates at day 28, so the line is skipped in its own period. Before this fix it leaked into every later period; now it is never paid. The final test pins that.
**Historical impact.** Every once-off batch posted before this commit left an open-ended row. Read-only, NOT run against production:
```sql
SELECT pe.company_id, pb.id AS batch_id, pb.description, pb.period_year, pb.period_month,
       COUNT(pec.id) AS open_ended_rows, SUM(pec.amount) AS amount_per_period
FROM payroll_batches pb
JOIN payroll_employee_components pec ON pec.component_id = pb.component_id
JOIN payroll_employees pe ON pe.id = pec.employee_id AND pe.company_id = pb.company_id
WHERE pb.status = 'posted' AND pb.is_recurring = false
  AND pec.is_recurring = false AND pec.effective_to IS NULL
GROUP BY 1,2,3,4,5 ORDER BY amount_per_period DESC;
```
Closing those rows changes PAYE/UIF/SDL already declared on an EMP201 — an accounting decision. This commit changes new posts only.
**Limits.** The impact query matches on the batch's own `component_id`, so it misses reimbursive-travel batches (3702/3703 need a separate sweep). Period end is computed in UTC while `getEmployeeComponents` derives its date from a local-time `Date`; same day for SAST, off by one west of UTC.
