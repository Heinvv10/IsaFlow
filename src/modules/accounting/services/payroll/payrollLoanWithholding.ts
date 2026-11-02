/**
 * A loan instalment the run cannot show is not taken (fail closed). applyLoanToRun takes the first
 * unpaid schedule row due in the period and its fringe benefit; when the payslip has no component
 * for either (payrollRunLoanComponents.loadLoanComponents), the loan is withheld instead: no payment
 * row, no schedule flag, no balance change, and the line says so. A zero instalment with no benefit
 * needs neither component and is taken as before. The same reading answers the MCP dry run, which
 * also counts the schedule row this run itself flagged, since a recalculation would unflag it first.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { fringeBenefitOf, listLoansWithInstalmentDue } from './payrollLoanService';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { loadLoanComponents } from './payrollRunLoanComponents';
import type { ValidationResult } from './payrollTypes';

export interface LoanComponentsPresent { deduction: boolean; fringe: boolean }

export interface WithheldLoan {
  loanId: string;
  loanNumber: string;
  employeeId: string;
  employeeNumber: string;
  /** Principal + interest of the one schedule row applyLoanToRun would take. */
  instalment: number;
  fringeBenefit: number;
  missing: 'deduction' | 'fringe';
}

export interface LoanInRun { loanId: string; companyId: string; runId: string; periodYear: number; periodMonth: number; officialRate: number }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Null when the loan can be taken (or has nothing due); otherwise what it would take and what is missing. */
export async function withholdingFor(loan: LoanInRun, present: LoanComponentsPresent, db: TxSql = sql): Promise<WithheldLoan | null> {
  const rows = (await db`
    SELECT l.id, l.loan_number, l.employee_id, pe.employee_number, l.annual_interest_rate,
           s.interest, s.principal, s.opening_balance
      FROM payroll_loans l
      JOIN payroll_employees pe ON pe.id = l.employee_id
      JOIN LATERAL (
        SELECT s.interest, s.principal, s.opening_balance
          FROM payroll_loan_schedule s
         WHERE s.loan_id = l.id
           AND s.due_period_year = ${loan.periodYear} AND s.due_period_month = ${loan.periodMonth}
           AND (s.paid_flag = false OR EXISTS (
             SELECT 1 FROM payroll_loan_payments p WHERE p.schedule_row_id = s.id AND p.run_id = ${loan.runId}::uuid))
         ORDER BY s.sequence
         LIMIT 1
      ) s ON true
     WHERE l.id = ${loan.loanId}::uuid AND l.company_id = ${loan.companyId}::uuid AND l.status = 'active'
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const instalment = round2(Number(r.interest) + Number(r.principal));
  const fringeBenefit = fringeBenefitOf(loan.officialRate, Number(r.annual_interest_rate), Number(r.opening_balance));
  const missing = instalment > 0 && !present.deduction ? 'deduction' : fringeBenefit > 0 && !present.fringe ? 'fringe' : null;
  if (!missing) return null;
  return {
    loanId: String(r.id), loanNumber: String(r.loan_number), employeeId: String(r.employee_id),
    employeeNumber: String(r.employee_number), instalment, fringeBenefit, missing,
  };
}

const KIND = {
  deduction: { code: 'LOAN_DEDUCTION_MISSING', component: 'deduction coded LOAN', amount: (w: WithheldLoan) => w.instalment },
  fringe: { code: 'LOAN_FRINGE_COMPONENT_MISSING', component: 'earning coded 3801 for the low-interest fringe benefit', amount: (w: WithheldLoan) => w.fringeBenefit },
} as const;

/** One blocking line result per employee and missing component, naming the loans (read by the approval gate). */
export function withheldLineResults(withheld: WithheldLoan[]): Map<string, ValidationResult[]> {
  const out = new Map<string, ValidationResult[]>();
  for (const missing of ['deduction', 'fringe'] as const) {
    const kind = KIND[missing];
    const byEmployee = new Map<string, WithheldLoan[]>();
    for (const w of withheld.filter((x) => x.missing === missing)) byEmployee.set(w.employeeId, [...(byEmployee.get(w.employeeId) ?? []), w]);
    for (const [employeeId, loans] of byEmployee) {
      out.set(employeeId, [...(out.get(employeeId) ?? []), {
        code: kind.code,
        severity: 'error',
        loans: loans.map((w) => w.loanNumber),
        message: `Loan ${loans.map((w) => `${w.loanNumber} (${formatMoney(kind.amount(w))})`).join(', ')}: no active ${kind.component}, `
          + 'so the instalment was not taken and the loan is unchanged. Add it under Setup → Pay Components, then recalculate.',
      }]);
    }
  }
  return out;
}

/** What a calculation of this run would withhold, read only (MCP calculate_pay_run, live and dry). */
export async function previewWithheldLoans(
  companyId: string, runId: string, period: { year: number; month: number }, officialRate: number,
): Promise<WithheldLoan[]> {
  const components = await loadLoanComponents(companyId);
  const present = { deduction: components.deduction != null, fringe: components.fringe != null };
  if (present.deduction && present.fringe) return [];
  const employees = new Set((await listPayrollRunEmployees(companyId, period)).map((e) => e.id));
  const out: WithheldLoan[] = [];
  for (const due of await listLoansWithInstalmentDue(companyId, period.year, period.month)) {
    if (!employees.has(due.employeeId)) continue;
    const held = await withholdingFor({ loanId: due.loanId, companyId, runId, periodYear: period.year, periodMonth: period.month, officialRate }, present);
    if (held) out.push(held);
  }
  return out.sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber) || a.loanNumber.localeCompare(b.loanNumber));
}

/** The loans a calculation of this run does not take, as the MCP calculate_pay_run reports them (live and dry). */
export async function withheldLoansReport(companyId: string, run: { id: string; periodYear: number; periodMonth: number }) {
  const held = await previewWithheldLoans(companyId, run.id, { year: run.periodYear, month: run.periodMonth }, runOfficialRate());
  return held.map((w) => ({
    employee_number: w.employeeNumber,
    loan_number: w.loanNumber,
    instalment: w.instalment,
    missing: w.missing === 'deduction' ? 'LOAN deduction' : '3801 earning',
  }));
}

/** The run's official rate, as calculatePayrollRun reads it. */
export const runOfficialRate = () => Number(process.env.SARS_OFFICIAL_RATE ?? 0.085);
