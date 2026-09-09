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
 * re-post while that id is set. So a run with a live journal is refused
 * outright when it has loan payments to undo.
 */

import { withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  applyLoanToRun,
  listActiveLoansForRun,
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
    await tx`SET LOCAL lock_timeout = '5s'`;

    try {
      await lockLoansForRun(input, tx);
    } catch (err) {
      if (isLockTimeout(err)) throw new PayrollLoanLockTimeoutError(input.runId);
      throw err;
    }

    const reversible = await listReversibleLoanPayments(
      input.companyId, input.runId, input.periodYear, input.periodMonth, tx,
    );
    if (reversible.length > 0 && input.journalEntryId != null) {
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

    return byEmployee;
  });
}
