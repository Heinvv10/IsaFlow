# K-022 fix — recalculating payroll dropped the loan deduction and kept the reduced balance

**Trigger.** Calculate a draft run with a loan instalment due, then calculate it again (Recalculate,
or any second call before the run locks).

**Before.** The first pass set `payroll_loan_schedule.paid_flag = true`, wrote a
`payroll_loan_payments` row and reduced `payroll_loans.outstanding_balance`. `calculatePayrollRun`
rebuilds `payroll_run_lines` on every call, but both `listActiveLoansForRun` and the schedule lookup
inside `applyLoanToRun` filter `paid_flag = false`, so the second pass offered no loan and injected
no LOAN deduction. Net pay rose by the instalment while the loan still read as repaid.

**After.** `calculatePayrollRun` calls `reverseLoanApplicationsForRun(companyId, runId)` immediately
before `listActiveLoansForRun`. It deletes the payment rows this run created (joined to
`payroll_loans` for the company scope), clears `paid_flag` on the matching schedule rows, adds the
principal back to `outstanding_balance`, subtracts it from `total_principal_paid` /
`total_interest_charged`, and returns a `settled` loan to `active` with `settled_at` cleared. The
forward path then re-applies identically, so recalculation is idempotent. The run-lock check at
`payrollRunService.ts:122` still runs first, so an approved run cannot be reversed. A payment another
run applied for the same period keeps its own `run_id` and is untouched.

**Files.**
- `src/modules/accounting/services/payroll/payrollLoanReversal.ts` (new, 71 lines)
- `src/modules/accounting/services/payroll/payrollRunService.ts` (import + one call + comment)
- `src/modules/accounting/services/payroll/.claude.md` + generated `AGENTS.md` mirror

**Tests.** `tests/integration/k022-payroll-recalc-drops-loan-deduction.int.test.ts` — 4 passed
against the real schema fixture DB: the validator's RED case, a third calculation reducing the
balance exactly once, an approved run rejected with `PayrollRunLockedError` and its loan state
untouched, and a second tenant whose loan is unaffected while its own run reopens and re-settles a
settled loan. Mutation check: commenting out the reversal call turns all 4 red (`green.log`).
`bunx tsc --noEmit` and `bunx eslint` on both changed source files are clean.

**Migration / rollback.** None. Revert the commit to roll back; no schema or data change.

**Historical-data impact.** Existing rows can already be wrong — the fix repairs nothing. Read-only
query (do NOT run on production without approval):

```sql
SELECT l.company_id, l.id, l.loan_number, l.principal, l.outstanding_balance,
       l.total_principal_paid, COALESCE(SUM(p.principal_paid),0) AS payments_recorded,
       l.principal - l.outstanding_balance - COALESCE(SUM(p.principal_paid),0) AS unexplained
  FROM payroll_loans l
  LEFT JOIN payroll_loan_payments p ON p.loan_id = l.id
 GROUP BY l.id
HAVING l.principal - l.outstanding_balance - COALESCE(SUM(p.principal_paid),0) <> 0;
```

Each hit is an employee whose payslip did not take the instalment while the loan reads as repaid, so
the staff-loan asset is overstated against what was actually recovered. Ran clean on the fixture DB;
not run on production.

**Limits.** The loan writes still sit outside the `withTransaction` block that rebuilds the run
lines, covered only by the `withAuth` request transaction — unchanged by this fix. The reversal is
not concurrency-guarded: two simultaneous calculations of the same run can still interleave, which
is a separate defect from the sequential one K-022 records.
