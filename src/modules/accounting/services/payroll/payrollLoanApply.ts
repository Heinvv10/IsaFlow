/** One loan's instalment taken by one pay run (moved out of payrollLoanService.ts, unchanged). */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fringeBenefitOf, round2, type LoanStatus } from './payrollLoanSchedule';

type Row = DbRow;

export interface ApplyLoanToRunInput {
  loanId: string;
  companyId: string;
  runId: string;
  periodYear: number;
  periodMonth: number;
  /** SARS official rate (REPO+1%) used to compute fringe benefit. */
  officialRate: number;
}

export interface ApplyLoanResult {
  loanId: string;
  loanNumber: string;
  employeeId: string;
  scheduleRowId: string;
  interest: number;
  principal: number;
  installment: number;
  fringeBenefit: number;
  openingBalance: number;
  closingBalance: number;
}

// `db` lets payrollRunLoanApplication run the reverse-then-apply pair on one
// transaction-bound executor; it defaults to the request client for every
// other caller.
export async function applyLoanToRun(
  input: ApplyLoanToRunInput,
  db: TxSql = sql,
): Promise<ApplyLoanResult | null> {
  const loanRows = (await db`
    SELECT id, company_id, employee_id, loan_number, status, outstanding_balance,
           total_interest_charged, total_principal_paid,
           method, annual_interest_rate
      FROM payroll_loans
     WHERE id = ${input.loanId}::uuid AND company_id = ${input.companyId}::uuid
     LIMIT 1
  `) as Row[];
  const loanRow = loanRows[0];
  if (!loanRow || loanRow.status !== 'active') return null;

  // ORDER BY sequence: the supporting index is not unique, so a bare LIMIT 1
  // would take whichever row the heap returned first.
  const scheduleRows = (await db`
    SELECT id, sequence, opening_balance, interest, principal, installment, closing_balance
      FROM payroll_loan_schedule
     WHERE loan_id = ${input.loanId}::uuid
       AND due_period_year = ${input.periodYear}
       AND due_period_month = ${input.periodMonth}
       AND paid_flag = false
     ORDER BY sequence
     LIMIT 1
  `) as Row[];
  const scheduleRow = scheduleRows[0];
  if (!scheduleRow) return null;

  const interest = Number(scheduleRow.interest);
  const principal = Number(scheduleRow.principal);
  const installment = Number(scheduleRow.installment);
  const opening = Number(scheduleRow.opening_balance);
  const closing = Number(scheduleRow.closing_balance);

  // Recorded on the payment so a reversal restores this exact figure: the
  // clamp below can subtract less than `principal`, and the schedule's own
  // opening/closing balances are not the loan's.
  const balanceBefore = Number(loanRow.outstanding_balance);

  const fringeBenefit = fringeBenefitOf(input.officialRate, Number(loanRow.annual_interest_rate), opening);

  await db`
    INSERT INTO payroll_loan_payments (
      loan_id, run_id, period_year, period_month,
      opening_balance, interest_charged, principal_paid, fringe_benefit, closing_balance,
      schedule_row_id, loan_balance_before
    ) VALUES (
      ${input.loanId}::uuid,
      ${input.runId}::uuid,
      ${input.periodYear},
      ${input.periodMonth},
      ${opening},
      ${interest},
      ${principal},
      ${fringeBenefit},
      ${closing},
      ${String(scheduleRow.id)}::uuid,
      ${balanceBefore}
    )
    ON CONFLICT (loan_id, period_year, period_month) DO UPDATE SET
      opening_balance = EXCLUDED.opening_balance,
      interest_charged = EXCLUDED.interest_charged,
      principal_paid = EXCLUDED.principal_paid,
      fringe_benefit = EXCLUDED.fringe_benefit,
      closing_balance = EXCLUDED.closing_balance,
      run_id = EXCLUDED.run_id,
      schedule_row_id = EXCLUDED.schedule_row_id,
      loan_balance_before = EXCLUDED.loan_balance_before
  `;

  await db`
    UPDATE payroll_loan_schedule
       SET paid_flag = true
     WHERE id = ${String(scheduleRow.id)}::uuid
  `;

  const newBalance = round2(Math.max(0, balanceBefore - principal));
  const newStatus: LoanStatus = newBalance <= 0.0001 ? 'settled' : 'active';

  await db`
    UPDATE payroll_loans
       SET outstanding_balance = ${newBalance},
           total_interest_charged = total_interest_charged + ${interest},
           total_principal_paid = total_principal_paid + ${principal},
           status = ${newStatus},
           settled_at = CASE WHEN ${newStatus} = 'settled' THEN NOW() ELSE settled_at END,
           updated_at = NOW()
     WHERE id = ${input.loanId}::uuid
  `;

  log.info(
    'Loan payment applied',
    {
      companyId: input.companyId,
      loanId: input.loanId,
      periodYear: input.periodYear,
      periodMonth: input.periodMonth,
      interest,
      principal,
      fringeBenefit,
      newBalance,
    },
    'payrollLoanService',
  );

  return {
    loanId: input.loanId,
    loanNumber: String(loanRow.loan_number),
    employeeId: String(loanRow.employee_id),
    scheduleRowId: String(scheduleRow.id),
    interest,
    principal,
    installment,
    fringeBenefit,
    openingBalance: opening,
    closingBalance: closing,
  };
}
