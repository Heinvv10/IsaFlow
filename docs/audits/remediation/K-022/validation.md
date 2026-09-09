# K-022 — Recalculating payroll drops the loan deduction, keeps the reduced balance

**Claim (as corrected by the approved plan).** Sequential recalculation removes the repayment deduction while retaining the reduced loan balance. The original double-decrement wording is not restated.

**Corrected trigger.** Calculate a run with an active loan instalment due, then calculate the same run again (Recalculate, or any second call before the run locks). The second payslip carries no LOAN deduction, so net pay rises by the instalment, while `payroll_loans.outstanding_balance` stays reduced.

**Disposition: confirmed.**

## Evidence
`git show ebeac9ca:src/modules/accounting/services/payroll/payrollLoanService.ts`:
- 400-410: the schedule lookup filters `paid_flag = false` and returns `null` when nothing matches.
- 446-450: the first pass sets `paid_flag = true`.
- 452-464: the first pass reduces `outstanding_balance` and raises `total_principal_paid`.
- 520-534: `listActiveLoansForRun` filters on the same `paid_flag = false`, so on the second pass the loan is not even offered to the run.
- `payrollRunService.ts:251-254` deletes and rebuilds `payroll_run_lines` on every call, so the payslip is regenerated from whatever `applyLoanToRun` returns — nothing. No function reverses `paid_flag` or the balance for a run being recalculated.
- Files unchanged between 5661d6f0 and ebeac9ca.
- RED `tests/integration/k022-payroll-recalc-drops-loan-deduction.int.test.ts` (1 failed): one employee on R20,000, one R1,000 instalment. First calculation gives LOAN deduction 1000, net 17,003.80, outstanding 9,000. Second gives deduction 0, net 18,003.80, outstanding still 9,000. Log: `red.log`.

## Reachability
`calculatePayrollRun` is the calculate/recalculate action and refuses only a locked run (line 122). Recalculating a draft after fixing components is ordinary payroll practice.

## Proposed minimal fix
Add `reverseLoanApplicationsForRun(companyId, runId)` to `payrollLoanService.ts`: for each `payroll_loan_payments` row with this `run_id`, add `principal_paid` back to `outstanding_balance`, subtract from `total_principal_paid` / `total_interest_charged`, reset `status` to `'active'` and `settled_at` to NULL, clear `paid_flag` on the matching schedule row, delete the payment row. Call it in `calculatePayrollRun` immediately before `listActiveLoansForRun` (line 156). The forward path then re-applies identically and recalculation becomes idempotent.

## Historical-data impact
```sql
SELECT l.company_id, l.id, l.loan_number, l.principal, l.outstanding_balance, l.total_principal_paid,
       COALESCE(SUM(p.principal_paid),0) AS payments_recorded,
       l.principal - l.outstanding_balance - COALESCE(SUM(p.principal_paid),0) AS unexplained
FROM payroll_loans l LEFT JOIN payroll_loan_payments p ON p.loan_id = l.id
GROUP BY l.id HAVING l.principal - l.outstanding_balance - COALESCE(SUM(p.principal_paid),0) <> 0;
```
Also cross-check runs whose payslip lacks a LOAN component despite a paid schedule row in that period (`payroll_run_lines.component_breakdown @> '[{"sarsSourceCode":"LOAN"}]'`). Each hit is an employee paid the instalment back while the loan reads as repaid, so the staff-loan asset is overstated against what was recovered.

## Risks
The reversal must sit on the same side of the transaction boundary as the re-application. Today the loan writes at 176-186 are OUTSIDE the `withTransaction` block at 251, covered only by the withAuth request transaction. The fix prevents new occurrences and repairs nothing existing.
