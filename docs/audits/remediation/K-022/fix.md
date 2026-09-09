# K-022 fix — recalculating payroll dropped the loan deduction and kept the reduced balance

**Trigger.** Calculate a draft run with a loan instalment due, then calculate it again.

**Before.** The first pass set `payroll_loan_schedule.paid_flag = true`, wrote a
`payroll_loan_payments` row and reduced `payroll_loans.outstanding_balance`. Both
`listActiveLoansForRun` and the schedule lookup in `applyLoanToRun` filter `paid_flag = false`, so
the second pass injected no LOAN deduction. Net pay rose by the instalment while the loan still read
as repaid.

**After.** `calculatePayrollRun` delegates the loan half to `applyRunLoans`, which in one
`withTransaction`, holding `FOR UPDATE` on the affected loans: refuses a run whose
`journal_entry_id` is still set; reverses the payments this run wrote; then re-applies the
instalments due. Recalculation is idempotent. `applyLoanToRun` and `listActiveLoansForRun` take an
optional `TxSql` executor so the whole sequence stays on one connection.

## Review findings from commit b77557ce, all addressed

- **HIGH-1** `reopenPayrollRun` moves an approved run to `calculated` and leaves the GL journal
  posted, so the reversal could move the subledger under a journal nothing re-posts. `applyRunLoans`
  now throws `PayrollRunJournalPostedError` when the run has a live `journal_entry_id` and payments
  to undo, directing the caller to `reversePayrollRunJournal` first.
- **MEDIUM-1** a loan closed between calculations is reversed but not re-applied. The delete is no
  longer traceless: each removed payment is tombstoned on `payroll_loan_payment_reversals`
  (migration 621) with `reapplied` set true only when the forward path retook it, and a
  `log.warn` names the loans it did not.
- **MEDIUM-2** reverse and re-apply now run in one transaction under `FOR UPDATE` with a 5s
  `lock_timeout`, raising `PayrollLoanLockTimeoutError` on contention.
- **LOW-1** a payment stranded by a deleted run (`run_id` set NULL by the FK) is reclaimed by
  period, so a replacement run takes the instalment again.
- **LOW-2** `applyLoanToRun`'s schedule lookup gained `ORDER BY sequence`; the supporting index is
  not unique, so the bare `LIMIT 1` took heap order.
- **LOW-3** the restore is `LEAST(principal, outstanding_balance + principal_paid)`, so a balance
  the forward path clamped at zero cannot be restored above the loan principal.
- **LOW-4** the loan orchestration moved out of `payrollRunService.ts`, which is now 487 lines,
  below the 498 it had before this work. Still over the 300-line cap, which predates it.
- **LOW-5** the test snapshot helper asserts row counts before indexing.

## Files

- `src/modules/accounting/services/payroll/payrollRunLoanApplication.ts` (new, 185 lines)
- `src/modules/accounting/services/payroll/payrollLoanReversal.ts` (new, 136 lines)
- `src/modules/accounting/services/payroll/payrollLoanService.ts` (executor param, `ORDER BY`)
- `src/modules/accounting/services/payroll/payrollRunService.ts` (call site)
- `scripts/migrations/sql/621_payroll_loan_payment_reversals.sql` (new)
- module `.claude.md` and its generated `AGENTS.md` mirror

## Tests

10 passed against the fixture DB: 4 in `tests/integration/k022-payroll-recalc-drops-loan-deduction.int.test.ts`
and 6 in `tests/integration/k022-payroll-loan-reversal-edge-cases.int.test.ts`. Full unit suite with
no fixture env: 9320 passed, 0 failed. `green.log` records every mutation check, including the one
that does not kill: removing `FOR UPDATE` while keeping the transaction leaves all 10 green. The
transaction boundary is what the concurrency tests prove; the lock is defence-in-depth.

## Migration / rollback

Migration 621 creates `payroll_loan_payment_reversals` with `IF NOT EXISTS`, RLS enabled and forced,
and a `tenant_isolation` policy. Applied twice to the fixture DB to prove idempotence; not run
against production. Prefix 620 was taken by the K-035 branch after this work started, so the file
was renamed to 621; re-check the prefix again before merging, as peers keep claiming numbers in this
range. Rollback: revert the commit and
`DROP TABLE payroll_loan_payment_reversals`.

## Historical-data impact

The fix repairs nothing existing. Read-only query, NOT run against production:

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
the staff-loan asset is overstated against what was recovered. It returned no rows on the fixture DB.

## Limits

`FOR UPDATE` is not killed by any test I could construct: with the transaction in place, the row
locks the DELETE and UPDATE take already serialise the single-loan case, and the `ON CONFLICT` on
`payroll_loan_payments` makes the surviving interleavings converge. A run with a live journal is now
refused rather than silently corrected, which changes behaviour for anyone recalculating a reopened
run that carries loan deductions.
