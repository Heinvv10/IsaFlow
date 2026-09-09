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
 * calculatePayrollRun() calls this before listActiveLoansForRun(), which
 * restores the run's own loan state and lets the forward path re-apply
 * identically. Scoped to the run: a payment another run applied for the same
 * period keeps its run_id and is left alone.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export async function reverseLoanApplicationsForRun(
  companyId: string,
  runId: string,
): Promise<number> {
  const reversed = (await sql`
    DELETE FROM payroll_loan_payments p
     USING payroll_loans l
     WHERE p.loan_id = l.id
       AND p.run_id = ${runId}::uuid
       AND l.company_id = ${companyId}::uuid
    RETURNING p.loan_id, p.period_year, p.period_month,
              p.principal_paid, p.interest_charged
  `) as Row[];

  for (const row of reversed) {
    const loanId = String(row.loan_id);
    const principal = Number(row.principal_paid);
    const interest = Number(row.interest_charged);

    await sql`
      UPDATE payroll_loan_schedule
         SET paid_flag = false
       WHERE loan_id = ${loanId}::uuid
         AND due_period_year = ${Number(row.period_year)}
         AND due_period_month = ${Number(row.period_month)}
    `;

    await sql`
      UPDATE payroll_loans
         SET outstanding_balance = outstanding_balance + ${principal},
             total_principal_paid = total_principal_paid - ${principal},
             total_interest_charged = total_interest_charged - ${interest},
             status = CASE WHEN status = 'settled' THEN 'active' ELSE status END,
             settled_at = CASE WHEN status = 'settled' THEN NULL ELSE settled_at END,
             updated_at = NOW()
       WHERE id = ${loanId}::uuid AND company_id = ${companyId}::uuid
    `;
  }

  if (reversed.length > 0) {
    log.info(
      'Loan applications reversed for recalculation',
      { companyId, runId, reversedCount: reversed.length },
      'payrollLoanReversal',
    );
  }

  return reversed.length;
}
