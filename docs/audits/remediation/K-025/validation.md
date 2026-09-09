# K-025 — Once-off payroll batches keep paying every month

**Claim (BB F47):** Batch assignments store `is_recurring = false` with a NULL `effective_to`,
so a once-off bonus recurs in every later run.

**Corrected trigger:** Two independent facts combine.
(a) `postBatch` copies the line's `effective_to` verbatim, and neither the API schema nor the UI
ever supplies one, so a once-off batch line becomes an open-ended assignment.
(b) The payroll reader ignores `is_recurring` altogether, so nothing downstream limits it.

**Disposition: confirmed.**

## Evidence
- `git show ebeac9ca:src/modules/accounting/services/payroll/payrollBatchService.ts`
  lines 489-509 `insertAssignment`: writes `effective_to` as passed (NULL allowed) and
  `is_recurring` as a plain column. Lines 406-416 / 429-451 pass the line's own `effective_to`.
- `pages/api/payroll/batches/[id]/lines.ts:34` - `effectiveTo` is `.optional().nullable()`.
- `pages/payroll/batches/[id].tsx:128-150` `buildLinePayload` never sets `effectiveTo`.
- `git show ebeac9ca:src/modules/accounting/services/payroll/payrollComponentService.ts:35-49`
  `getEmployeeComponents` filters on `effective_from`/`effective_to` and `pc.is_active` only.
  `is_recurring` appears nowhere in the query.
- That function is the reader used by `payrollRunService.ts:166` inside `calculatePayrollRun`,
  and by `pages/api/payroll/employees/[id]/termination.ts:57`.
- File unchanged between 5661d6f0 and ebeac9ca.

## Reachability
`POST /api/payroll/batches/:id/post` (`withAuth ... withWriteAccess`) then every subsequent
`calculatePayrollRun`. The "Apply as recurring" checkbox in `pages/payroll/batches/new.tsx:149`
defaults to OFF and is labelled "default is once-off", so the once-off path is the common one.

## RED test
`tests/integration/k025-once-off-batch-recurs.int.test.ts` - real Postgres, real service calls
(createBatch, addBatchLines, validateBatch, postBatch), then `getEmployeeComponents` at the
period dates `calculatePayrollRun` uses. 4 tests, 4 failing (`red.log`).

## Second defect the test exposed (same path, separate root cause)
The UI defaults a line's `effectiveFrom` to the LAST DAY of the batch period
(`endOfMonth`, `pages/payroll/batches/[id].tsx:61,78`), while `calculatePayrollRun` evaluates
components at DAY 28 (`payrollRunService.ts:130`). A March batch has
`effective_from = 2025-03-31 > 2025-03-28`, so it is skipped in the very month it was captured
for and then paid in every month after. The test "the bonus IS paid in the batch period it was
captured for" fails on this. Needs its own K id; do not fold it into the K-025 fix silently.

## Proposed minimal fix (3-6 lines)
1. `payrollBatchService.postBatch`: when `batch.isRecurring === false`, close the assignment -
   pass `effectiveTo: line.effective_to ?? endOfBatchPeriod(batch.periodYear, batch.periodMonth)`
   into `insertAssignment` (both the component_values and reimbursive_travel arms).
2. Leave the reader unchanged; closing the row at post time is the smaller, auditable change.

## Historical-data impact
Every posted once-off batch to date left an open-ended assignment paid in every run since.
Read-only impact query:

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
NOT run against production. Correcting history means closing those rows AND recalculating every
affected run, which changes PAYE/UIF/SDL already declared on an EMP201. That is an accounting
decision, not a code change.

## Risks
Backfilling `effective_to` on existing rows silently changes future runs for companies that
intended the recurrence but left the checkbox off. Close only rows whose parent batch is
`is_recurring = false`, and report the list before writing.
