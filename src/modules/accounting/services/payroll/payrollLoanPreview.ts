import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import {
  fringeBenefitOf,
  type ApplyLoanResult,
  type ApplyLoanToRunInput,
} from './payrollLoanService';

/** Read the instalment applyLoanToRun would take, without changing the loan. Caller holds the loan lock. */
export async function previewLoanToRun(
  input: ApplyLoanToRunInput,
  db: TxSql = sql,
): Promise<ApplyLoanResult | null> {
  const rows = (await db`
    SELECT l.id, l.loan_number, l.employee_id, l.annual_interest_rate,
           s.id AS schedule_row_id, s.interest, s.principal, s.installment,
           s.opening_balance, s.closing_balance
      FROM payroll_loans l
      JOIN LATERAL (
        SELECT id, interest, principal, installment, opening_balance, closing_balance
          FROM payroll_loan_schedule
         WHERE loan_id = l.id
           AND due_period_year = ${input.periodYear}
           AND due_period_month = ${input.periodMonth}
           AND paid_flag = false
         ORDER BY sequence LIMIT 1
      ) s ON true
     WHERE l.id = ${input.loanId}::uuid
       AND l.company_id = ${input.companyId}::uuid
       AND l.status = 'active'
  `) as DbRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    loanId: String(row.id), loanNumber: String(row.loan_number), employeeId: String(row.employee_id),
    scheduleRowId: String(row.schedule_row_id), interest: Number(row.interest), principal: Number(row.principal),
    installment: Number(row.installment),
    fringeBenefit: fringeBenefitOf(input.officialRate, Number(row.annual_interest_rate), Number(row.opening_balance)),
    openingBalance: Number(row.opening_balance), closingBalance: Number(row.closing_balance),
  };
}
