# K-022 fix — recalculating payroll dropped the loan deduction and kept the reduced balance

**Trigger.** Calculate a draft run with a loan instalment due, then calculate it again.

**Before.** The first pass set `payroll_loan_schedule.paid_flag = true`, wrote a
`payroll_loan_payments` row and reduced `payroll_loans.outstanding_balance`. Both
`listActiveLoansForRun` and the schedule lookup in `applyLoanToRun` filter `paid_flag = false`, so
the second pass injected no LOAN deduction. Net pay rose by the instalment while the loan still read
as repaid.

**After.** `calculatePayrollRun` delegates the loan half to `applyRunLoans`, which in one
`withTransaction` holding `FOR UPDATE` on the affected loans: refuses a run whose `journal_entry_id`
is still set, reverses the payments this run wrote, then re-applies the instalments due.
Recalculation is idempotent. `applyLoanToRun` and `listActiveLoansForRun` take an optional `TxSql`
executor so the whole sequence stays on one connection.

## First review (8 findings), all addressed

- **HIGH-1** a reopened run keeps its posted GL journal, so the reversal could move the subledger
  under a journal nothing re-posts. `applyRunLoans` throws `PayrollRunJournalPostedError`.
- **MEDIUM-1** a loan closed between calculations is reversed but not re-applied. Each removed
  payment is tombstoned on `payroll_loan_payment_reversals` (migration 621), `reapplied` set only
  when the forward path retook it, and a `log.warn` names the rest.
- **MEDIUM-2** reverse and re-apply run in one transaction under `FOR UPDATE`, 5s `lock_timeout`,
  raising `PayrollLoanLockTimeoutError`.
- **LOW-1** a payment stranded by a deleted run is reclaimed by period.
- **LOW-2, LOW-3** now exact, see below. **LOW-4** see Limits. **LOW-5** test row reads guarded.

## Second review (2 MEDIUM, 4 LOW, 3 partials), all addressed

- **MEDIUM-A** the journal guard only covered the reverse path, so a run with a live journal still
  took NEW instalments. The guard now reads `listLoansWithInstalmentDue` — active loans with a
  schedule row for the period, ignoring `paid_flag` — before touching anything, and refuses on
  either side. `paid_flag` had to be ignored here: the filtered list is empty on a recalculation
  until the reversal has run, which would hide exactly the work being guarded.
- **MEDIUM-B** neither new error class reached the caller. Both are mapped to
  `apiResponse.badRequest` in `pages/api/payroll/runs/[id]/calculate.ts` and to `toolError` in
  `calculate_pay_run`. Unexpected errors still propagate so the request rolls back.
- **LOW-A** the reviewer's two-client `FOR UPDATE` test is adopted. It holds a competing row lock
  from a second connection and asserts `PayrollLoanLockTimeoutError` plus an empty tombstone table.
  It goes red when the lock is removed.
- **LOW-B** `SET LOCAL` is transaction-scoped, so under `withAuth` the 5s timeout leaked past the
  savepoint into the rest of the request. The previous value is captured and restored via
  `set_config(..., is_local => true)`, which unlike `SET` accepts a bind parameter. Not restored on
  the error path: that statement has aborted the transaction, so a further query answers 25P02 and
  masks the cause, and the savepoint rollback restores it anyway.
- **LOW-C** reclaiming a stranded payment is a repair of someone else's row that the journal guard
  cannot cover, since the original run is gone. Tombstones carry `stranded` to tell the two apart.
- **LOW-D** every `rows[0]` read in the tests is behind a length assertion.
- **LOW-2 (partial → done)** migration 622 records `payroll_loan_payments.schedule_row_id`, so the
  undo clears the row that was flagged rather than every row for the period.
- **LOW-3 (partial → done)** migration 622 records `loan_balance_before`, which bounds the restore
  in the clamp case. Rows written before 622 keep NULL and use the previous approximate path.

## Third review (1 HIGH regression, 1 MEDIUM), both fixed

- **HIGH-1** the round-3 restore assigned `loan_balance_before` absolutely, which overwrote anything
  that had moved the balance since. A later period's instalment is exactly such a mover: with March
  and April both taken, recalculating March erased April's R1,000 from the balance while its payment
  row and `total_principal_paid` still recorded it — the staff-loan asset overstated against what was
  recovered, which is the harm K-022 exists to prevent. The restore is now RELATIVE:
  `outstanding_balance + LEAST(principal_paid, loan_balance_before)`, which adds back exactly what
  `applyLoanToRun` subtracted, clamp included. Both operands are cast `::numeric` — `LEAST` over two
  untyped bind parameters deduces text, and `numeric + text` has no operator.
- **MEDIUM-1** `dry_run` on `calculate_pay_run` promised a recost that the live call would refuse.
  Both paths now call `runHasLoanWork`, so the dry run reports the refusal in `skipped` and leaves
  `effects` empty. It only reads the loans when a journal is actually posted.

## Files

`payrollRunLoanApplication.ts` (new), `payrollLoanReversal.ts` (new), `payrollLoanService.ts`,
`payrollRunService.ts`, `pages/api/payroll/runs/[id]/calculate.ts`, `src/lib/mcp/tools/writePayrollRun.ts`,
`scripts/migrations/sql/621_payroll_loan_payment_reversals.sql`,
`scripts/migrations/sql/622_payroll_loan_reversal_precision.sql`, module `.claude.md` and its mirror.

## Tests

15 integration tests across the two K-022 files, plus 4 route tests in
`tests/unit/api/payrollCalculateRefusals.test.ts` and 5 added to `tests/unit/mcp/payRunLifecycle.test.ts`.
`green.log` lists every mutation check; all eight kill, including `FOR UPDATE`, the absolute-restore
regression and the dry-run guard.

## Migrations / rollback

621 creates `payroll_loan_payment_reversals` (RLS enabled and forced, `tenant_isolation` policy).
622 adds three nullable columns with no backfill. Both use `IF NOT EXISTS`, were applied twice to the
fixture DB to prove idempotence, and are tracked in `schema_migrations`. Neither was run against
production. Prefixes were free across all worktrees when taken; peers claim numbers in this range
constantly, so re-check before merging. Rollback: revert the commits, drop the table and the three
columns.

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
the staff-loan asset is overstated against what was recovered.

## Limits

**LOW-4 is deliberately not finished.** `payrollRunService.ts` is 487 lines and
`payrollLoanService.ts` 580, both over the 300-line cap and both over it before this work. Splitting
either is an adjacent refactor of code K-022 does not touch, which the fixer brief forbids and which
would collide with the peer branches editing those files. The two new files are 220 and 183 lines.

The journal guard is deliberately coarse: on a journal-posted run, ANY active loan with an instalment
due that period blocks recalculation, even where the recalculation would change nothing about that
loan. So a reopened run carrying loans cannot be recalculated until its journal is reversed. That is
the conservative reading and the message names the remedy, but it is a real workflow constraint, not
an edge case. The `stranded` reclaim path remains outside the guard by construction — the original
run is gone, so there is no `journal_entry_id` left to check.

Informational: `ADD COLUMN ... REFERENCES payroll_loan_schedule(id)` in 622 takes a brief ACCESS
EXCLUSIVE lock on `payroll_loan_payments`. The column is all-NULL so nothing is validated, but on a
large table the lock is still taken.
