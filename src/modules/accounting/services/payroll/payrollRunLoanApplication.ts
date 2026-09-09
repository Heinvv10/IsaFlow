/**
 * The loan half of calculatePayrollRun: undo what this run applied before,
 * then apply the instalments due, atomically and under a row lock.
 *
 * Why one transaction. Reversal and re-application are two halves of one
 * correction. Split across autocommitted statements, two concurrent
 * calculations of the same run interleave: the second reverses nothing
 * (the first has not committed its payment row yet), then reads
 * paid_flag = true from the first and offers no loan — the payslip loses the
 * deduction while the balance stays reduced, which is defect K-022 itself.
 * A `FOR UPDATE` over the affected loans, taken before the reversal reads
 * them and held to the end of this block, serialises the pair.
 *
 * Why the journal guard. `reopenPayrollRun` moves an approved run back to
 * `calculated` and deliberately leaves `journal_entry_id` set — the GL entry
 * posted at approval is NOT reversed. Recalculating then would move the loan
 * subledger under a posted journal that `postPayrollRunJournal` refuses to
 * re-post while that id is set. The guard covers BOTH directions: undoing an
 * instalment the journal already reflects, and taking a NEW instalment the
 * journal never saw. Either leaves the payslip and the subledger disagreeing
 * with a journal nothing will re-post.
 */

import { withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  applyLoanToRun,
  listActiveLoansForRun,
  listLoansWithInstalmentDue,
  type ApplyLoanResult,
} from './payrollLoanService';
import { listReversibleLoanPayments, reverseLoanApplicationsForRun } from './payrollLoanReversal';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

export class PayrollRunJournalPostedError extends Error {
  readonly code = 'PAYROLL_RUN_JOURNAL_POSTED';
  constructor(runId: string) {
    super(
      `Payroll run ${runId} still has a posted GL journal, so its loan deductions cannot be `
      + 'recalculated. Reverse the payroll journal first, then recalculate.',
    );
    this.name = 'PayrollRunJournalPostedError';
  }
}

export class PayrollLoanLockTimeoutError extends Error {
  readonly code = 'PAYROLL_LOAN_LOCK_TIMEOUT';
  constructor(runId: string) {
    super(`Payroll run ${runId} is being calculated by another request — retry in a moment.`);
    this.name = 'PayrollLoanLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Transaction-local `lock_timeout`, via set_config rather than SET LOCAL:
 * `SET` takes no bind parameters, and set_config with is_local = true has the
 * same scope. Returns the value that was in force before the change.
 */
async function setLocalLockTimeout(tx: TxSql, value: string): Promise<string> {
  const rows = (await tx`
    SELECT current_setting('lock_timeout', true) AS previous,
           set_config('lock_timeout', ${value}, true) AS applied
  `) as DbRow[];
  return String(rows[0]?.previous ?? '0');
}

export interface RunLoanInput {
  companyId: string;
  runId: string;
  periodYear: number;
  periodMonth: number;
  officialRate: number;
  /** `payroll_run_headers.journal_entry_id` — non-null means the GL entry is live. */
  journalEntryId: string | null;
}

/**
 * Lock every loan this run could touch: the ones it already paid and the ones
 * with an instalment due this period. Ordered by id so two runs competing for
 * the same loans cannot deadlock against each other.
 */
async function lockLoansForRun(input: RunLoanInput, db: TxSql): Promise<number> {
  const rows = (await db`
    SELECT l.id
      FROM payroll_loans l
     WHERE l.company_id = ${input.companyId}::uuid
       AND (
         EXISTS (
           SELECT 1 FROM payroll_loan_payments p
            WHERE p.loan_id = l.id
              AND (p.run_id = ${input.runId}::uuid
                   OR (p.run_id IS NULL
                       AND p.period_year = ${input.periodYear}
                       AND p.period_month = ${input.periodMonth}))
         )
         OR EXISTS (
           SELECT 1 FROM payroll_loan_schedule s
            WHERE s.loan_id = l.id
              AND s.due_period_year = ${input.periodYear}
              AND s.due_period_month = ${input.periodMonth}
         )
       )
     ORDER BY l.id
       FOR UPDATE
  `) as DbRow[];
  return rows.length;
}

/**
 * Reverse this run's earlier loan payments and re-apply the instalments due,
 * returning the applications keyed by employee for the payslip build.
 */
export async function applyRunLoans(
  input: RunLoanInput,
): Promise<Map<string, ApplyLoanResult[]>> {
  return withTransaction(async (tx) => {
    // Bound the wait so a wedged peer surfaces as a retryable error instead of
    // pinning the connection. Re-issued every call: SET LOCAL is
    // subtransaction-aware and a savepoint rollback restores the default of 0.
    //
    // SET LOCAL is scoped to the TRANSACTION, not to this block. Under withAuth
    // a request transaction is already open and withTransaction only nests a
    // savepoint, so the 5s would otherwise stay in force for the rest of the
    // request — the run-lines rebuild included. Captured and put back.
    const previousLockTimeout = await setLocalLockTimeout(tx, '5s');

    try {
      await lockLoansForRun(input, tx);
    } catch (err) {
      // No restore here: the statement that failed has aborted the
      // transaction, so any further query answers 25P02 and would mask the
      // real cause. withTransaction's savepoint rollback restores the previous
      // lock_timeout on its own.
      if (isLockTimeout(err)) throw new PayrollLoanLockTimeoutError(input.runId);
      throw err;
    }

    const reversible = await listReversibleLoanPayments(
      input.companyId, input.runId, input.periodYear, input.periodMonth, tx,
    );
    // Read both sides before touching anything: a live journal blocks taking a
    // NEW instalment just as surely as undoing an old one. The forward side is
    // read with listLoansWithInstalmentDue, which ignores paid_flag — the
    // paid_flag-filtered list below is empty on a recalculation until the
    // reversal has run, and would hide exactly the work being guarded.
    const dueThisPeriod = await listLoansWithInstalmentDue(
      input.companyId, input.periodYear, input.periodMonth, tx,
    );
    if (input.journalEntryId != null && (reversible.length > 0 || dueThisPeriod.length > 0)) {
      throw new PayrollRunJournalPostedError(input.runId);
    }

    await reverseLoanApplicationsForRun(input.companyId, input.runId, reversible, tx);

    const active = await listActiveLoansForRun(
      input.companyId, input.periodYear, input.periodMonth, tx,
    );

    const byEmployee = new Map<string, ApplyLoanResult[]>();
    for (const row of active) {
      const applied = await applyLoanToRun({
        loanId: row.loanId,
        companyId: input.companyId,
        runId: input.runId,
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
        officialRate: input.officialRate,
      }, tx);
      if (!applied) continue;
      const list = byEmployee.get(applied.employeeId) ?? [];
      list.push(applied);
      byEmployee.set(applied.employeeId, list);
    }

    // A loan closed between two calculations is reversed but not re-applied:
    // listActiveLoansForRun offers only `active` loans. The payslip then takes
    // no instalment and the balance is restored to match, which is correct —
    // but nothing else records that the instalment was undone for good, so the
    // tombstone is marked and the caller's log says which loans.
    const reapplied = new Set(
      Array.from(byEmployee.values()).flat().map(a => a.loanId),
    );
    for (const payment of reversible) {
      if (!reapplied.has(payment.loanId)) continue;
      await tx`
        UPDATE payroll_loan_payment_reversals
           SET reapplied = true
         WHERE company_id = ${input.companyId}::uuid
           AND loan_id = ${payment.loanId}::uuid
           AND run_id = ${input.runId}::uuid
           AND period_year = ${payment.periodYear}
           AND period_month = ${payment.periodMonth}
           AND reapplied = false
      `;
    }
    const notReapplied = reversible.filter(p => !reapplied.has(p.loanId));
    if (notReapplied.length > 0) {
      log.warn(
        'Loan payments reversed without re-application — loan no longer active for this period',
        {
          companyId: input.companyId,
          runId: input.runId,
          loanIds: notReapplied.map(p => p.loanId),
        },
        'payrollRunLoanApplication',
      );
    }

    await setLocalLockTimeout(tx, previousLockTimeout);
    return byEmployee;
  });
}
