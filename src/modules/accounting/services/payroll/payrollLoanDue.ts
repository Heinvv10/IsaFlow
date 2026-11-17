/** The loans with an instalment due in a calendar month (moved out of payrollLoanService.ts, unchanged). */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';

type Row = DbRow;

/**
 * Active loans with an instalment scheduled for this period, whether or not it
 * is already flagged paid. Unlike listActiveLoansForRun this is stable across
 * a reversal, so callers can ask "is there loan work on this run?" before
 * undoing anything.
 */
export async function listLoansWithInstalmentDue(
  companyId: string,
  periodYear: number,
  periodMonth: number,
  db: TxSql = sql,
): Promise<Array<{ loanId: string; employeeId: string }>> {
  const rows = (await db`
    SELECT DISTINCT l.id AS loan_id, l.employee_id
      FROM payroll_loans l
      JOIN payroll_loan_schedule s ON s.loan_id = l.id
     WHERE l.company_id = ${companyId}::uuid
       AND l.status = 'active'
       AND s.due_period_year = ${periodYear}
       AND s.due_period_month = ${periodMonth}
  `) as Row[];
  return rows.map(r => ({ loanId: String(r.loan_id), employeeId: String(r.employee_id) }));
}

export async function listActiveLoansForRun(
  companyId: string,
  periodYear: number,
  periodMonth: number,
  db: TxSql = sql,
): Promise<Array<{ loanId: string; employeeId: string }>> {
  const rows = (await db`
    SELECT DISTINCT l.id AS loan_id, l.employee_id
      FROM payroll_loans l
      JOIN payroll_loan_schedule s ON s.loan_id = l.id
     WHERE l.company_id = ${companyId}::uuid
       AND l.status = 'active'
       AND s.paid_flag = false
       AND s.due_period_year = ${periodYear}
       AND s.due_period_month = ${periodMonth}
  `) as Row[];
  return rows.map(r => ({ loanId: String(r.loan_id), employeeId: String(r.employee_id) }));
}
