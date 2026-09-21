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
 * that can ever undo it. Those rows are reclaimed by period and tombstoned
 * with stranded = true, because reclaiming someone else's row is not the same
 * act as undoing this run's own work.
 *
 * The rows are hard-deleted (the unique key on (loan_id, period_year,
 * period_month) leaves no room for a compensating row), so what was deleted is
 * tombstoned on payroll_loan_payment_reversals first (migration 621).
 *
 * Exactness: migration 622 records schedule_row_id and loan_balance_before on
 * every new payment, so the undo clears the row that was actually flagged and
 * adds back exactly what was subtracted. The restore is RELATIVE — the amount
 * applyLoanToRun took is LEAST(principal_paid, loan_balance_before), because of
 * its zero-clamp, and that is what goes back. Assigning loan_balance_before
 * absolutely would overwrite anything that moved the balance since, and a later
 * period's instalment is exactly such a mover: recalculating March would erase
 * April's repayment from the balance while its payment row still recorded it.
 * Rows written before 622 carry NULL and fall back to matching by period and
 * adding the principal back, bounded by the loan principal.
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
  /** NULL when the payment's own run was deleted and this run is reclaiming it. */
  runId: string | null;
  /** The schedule row this payment flagged. NULL before migration 622. */
  scheduleRowId: string | null;
  /** The loan balance the payment started from. NULL before migration 622. */
  loanBalanceBefore: number | null;
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
           p.principal_paid, p.interest_charged, p.run_id,
           p.schedule_row_id, p.loan_balance_before
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
    scheduleRowId: r.schedule_row_id == null ? null : String(r.schedule_row_id),
    loanBalanceBefore: r.loan_balance_before == null ? null : Number(r.loan_balance_before),
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
        principal_reversed, interest_reversed, stranded
      ) VALUES (
        ${companyId}::uuid, ${payment.loanId}::uuid, ${runId}::uuid,
        ${payment.periodYear}, ${payment.periodMonth},
        ${payment.principalPaid}, ${payment.interestCharged},
        ${payment.runId == null}
      )
    `;

    await db`
      DELETE FROM payroll_loan_payments WHERE id = ${payment.paymentId}::uuid
    `;

    if (payment.scheduleRowId != null) {
      await db`
        UPDATE payroll_loan_schedule
           SET paid_flag = false
         WHERE id = ${payment.scheduleRowId}::uuid
           AND loan_id = ${payment.loanId}::uuid
      `;
    } else {
      // Pre-622 payment: the flagged row was not recorded, so every schedule
      // row for the period is cleared. A superset, and safe — the forward path
      // re-flags exactly one.
      await db`
        UPDATE payroll_loan_schedule
           SET paid_flag = false
         WHERE loan_id = ${payment.loanId}::uuid
           AND due_period_year = ${payment.periodYear}
           AND due_period_month = ${payment.periodMonth}
      `;
    }

    if (payment.loanBalanceBefore != null) {
      // Exactly what was subtracted, added back relatively. LEAST covers the
      // zero-clamp: a R1,000 instalment against a R400 balance took only R400.
      // Both operands are cast: LEAST over two untyped bind parameters deduces
      // text, and `numeric + text` has no operator.
      await db`
        UPDATE payroll_loans
           SET outstanding_balance = outstanding_balance
                 + LEAST(${payment.principalPaid}::numeric, ${payment.loanBalanceBefore}::numeric),
               total_principal_paid = total_principal_paid - ${payment.principalPaid},
               total_interest_charged = total_interest_charged - ${payment.interestCharged},
               status = CASE WHEN status = 'settled' THEN 'active' ELSE status END,
               settled_at = CASE WHEN status = 'settled' THEN NULL ELSE settled_at END,
               updated_at = NOW()
         WHERE id = ${payment.loanId}::uuid AND company_id = ${companyId}::uuid
      `;
    } else {
      // Pre-622 payment: add the principal back, bounded by the loan principal
      // so a clamped balance cannot be restored above it.
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
  }

  log.info(
    'Loan applications reversed for recalculation',
    {
      companyId,
      runId,
      reversedCount: payments.length,
      reclaimedStranded: payments.filter(p => p.runId == null).length,
    },
    'payrollLoanReversal',
  );

  return payments.length;
}
