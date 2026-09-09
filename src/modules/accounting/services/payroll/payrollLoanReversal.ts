/**
 * Undo the loan deductions a payroll run already applied, so recalculating
 * that run is idempotent.
 *
 * applyLoanToRun() marks the schedule row paid_flag = true and decrements
 * payroll_loans.outstanding_balance. Both listActiveLoansForRun() and the
 * schedule lookup inside applyLoanToRun() filter paid_flag = false, so a
 * second calculation of the same run offers no loan and injects no LOAN
 * deduction — while the balance stays reduced. The employee is paid the
 * instalment back and the loan still reads as repaid.
 *
 * Called from payrollRunLoanApplication.ts, which holds a row lock over the
 * reverse-then-re-apply pair. Every statement runs on the executor passed in,
 * so the whole sequence stays on one connection inside one transaction.
 *
 * Scoping: a payment another run applied keeps its own run_id and is left
 * alone. The one exception is a payment whose run was deleted — the FK is
 * ON DELETE SET NULL, so it is stranded with paid_flag still true and no run
 * that can ever undo it. Those rows are reclaimed by period.
 *
 * The rows are hard-deleted (the unique key on (loan_id, period_year,
 * period_month) leaves no room for a compensating row), so what was deleted is
 * tombstoned on payroll_loan_payment_reversals first (migration 621).
 */

import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface ReversibleLoanPayment {
  paymentId: string;
  loanId: string;
  periodYear: number;
  periodMonth: number;
  principalPaid: number;
  interestCharged: number;
  runId: string | null;
}

/**
 * The payment rows a recalculation of this run would undo: the ones it wrote
 * itself, plus any stranded by a deleted run for the same period.
 */
export async function listReversibleLoanPayments(
  companyId: string,
  runId: string,
  periodYear: number,
  periodMonth: number,
  db: TxSql = sql,
): Promise<ReversibleLoanPayment[]> {
  const rows = (await db`
    SELECT p.id, p.loan_id, p.period_year, p.period_month,
           p.principal_paid, p.interest_charged, p.run_id
      FROM payroll_loan_payments p
      JOIN payroll_loans l ON l.id = p.loan_id
     WHERE l.company_id = ${companyId}::uuid
       AND (
         p.run_id = ${runId}::uuid
         OR (p.run_id IS NULL
             AND p.period_year = ${periodYear}
             AND p.period_month = ${periodMonth})
       )
     ORDER BY p.loan_id
  `) as Row[];
  return rows.map(r => ({
    paymentId: String(r.id),
    loanId: String(r.loan_id),
    periodYear: Number(r.period_year),
    periodMonth: Number(r.period_month),
    principalPaid: Number(r.principal_paid),
    interestCharged: Number(r.interest_charged),
    runId: r.run_id == null ? null : String(r.run_id),
  }));
}

export async function reverseLoanApplicationsForRun(
  companyId: string,
  runId: string,
  payments: ReversibleLoanPayment[],
  db: TxSql = sql,
): Promise<number> {
  if (payments.length === 0) return 0;

  for (const payment of payments) {
    // Tombstone before the delete: payroll_loan_payments is the only record
    // that the instalment was ever taken, and the unique key per period rules
    // out a compensating row.
    await db`
      INSERT INTO payroll_loan_payment_reversals (
        company_id, loan_id, run_id, period_year, period_month,
        principal_reversed, interest_reversed
      ) VALUES (
        ${companyId}::uuid, ${payment.loanId}::uuid, ${runId}::uuid,
        ${payment.periodYear}, ${payment.periodMonth},
        ${payment.principalPaid}, ${payment.interestCharged}
      )
    `;

    await db`
      DELETE FROM payroll_loan_payments WHERE id = ${payment.paymentId}::uuid
    `;

    await db`
      UPDATE payroll_loan_schedule
         SET paid_flag = false
       WHERE loan_id = ${payment.loanId}::uuid
         AND due_period_year = ${payment.periodYear}
         AND due_period_month = ${payment.periodMonth}
    `;

    // LEAST bounds the restore: applyLoanToRun clamps the balance at zero, so
    // on a final instalment larger than the balance it subtracted less than
    // the full principal. Restoring blindly would push the loan above its own
    // principal.
    await db`
      UPDATE payroll_loans
         SET outstanding_balance = LEAST(principal, outstanding_balance + ${payment.principalPaid}),
             total_principal_paid = total_principal_paid - ${payment.principalPaid},
             total_interest_charged = total_interest_charged - ${payment.interestCharged},
             status = CASE WHEN status = 'settled' THEN 'active' ELSE status END,
             settled_at = CASE WHEN status = 'settled' THEN NULL ELSE settled_at END,
             updated_at = NOW()
       WHERE id = ${payment.loanId}::uuid AND company_id = ${companyId}::uuid
    `;
  }

  log.info(
    'Loan applications reversed for recalculation',
    { companyId, runId, reversedCount: payments.length },
    'payrollLoanReversal',
  );

  return payments.length;
}
