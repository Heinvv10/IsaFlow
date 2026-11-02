/**
 * A loan instalment the payslip has no LOAN deduction for is not taken (fail closed). applyLoanToRun
 * takes the first unpaid schedule row due in the period; when the run has no active deduction coded
 * LOAN (payrollRunLoanComponents.loadLoanComponents), the loan is withheld instead: no payment row,
 * no schedule flag, no balance change, and the line says so (LOAN_DEDUCTION_MISSING, a blocker).
 * A missing 3801 earning does NOT withhold (Hein, 2026-11-02): the loan is collected as before and
 * the line warns that its fringe benefit was not recorded (LOAN_FRINGE_NOT_RECORDED). A zero
 * instalment is taken without a LOAN deduction, as before.
 *
 * The MCP dry run asks the same question before a recalculation would have undone this run's own
 * loan work, so it reads the loan as that reversal would leave it (payrollLoanReversal): a payment
 * this run made, or one stranded by a deleted run for this period (run_id NULL), is undone, which
 * unflags its schedule row (every row of the period for a pre-622 payment with no row recorded)
 * and turns a loan it settled active again. A cancelled or written-off loan stays out, as there.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { fringeBenefitOf, type ApplyLoanResult } from './payrollLoanService';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { loadLoanComponents, type LoanComponents } from './payrollRunLoanComponents';
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
  /** Always the LOAN deduction; the 3801 earning too when that is also missing and the loan has a benefit. */
  missing: Array<'deduction' | 'fringe'>;
}

export interface LoanInRun { loanId: string; companyId: string; runId: string; periodYear: number; periodMonth: number; officialRate: number }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Null when the loan can be taken (or has nothing due); otherwise what it would take and what is missing. */
export async function withholdingFor(loan: LoanInRun, present: LoanComponentsPresent, db: TxSql = sql): Promise<WithheldLoan | null> {
  if (present.deduction) return null;
  const rows = (await db`
    WITH undone AS (
      SELECT p.schedule_row_id FROM payroll_loan_payments p
       WHERE p.loan_id = ${loan.loanId}::uuid
         AND (p.run_id = ${loan.runId}::uuid
           OR (p.run_id IS NULL AND p.period_year = ${loan.periodYear} AND p.period_month = ${loan.periodMonth}))
    )
    SELECT l.id, l.loan_number, l.employee_id, pe.employee_number, l.annual_interest_rate,
           s.interest, s.principal, s.opening_balance
      FROM payroll_loans l
      JOIN payroll_employees pe ON pe.id = l.employee_id
      JOIN LATERAL (
        SELECT s.interest, s.principal, s.opening_balance
          FROM payroll_loan_schedule s
         WHERE s.loan_id = l.id
           AND s.due_period_year = ${loan.periodYear} AND s.due_period_month = ${loan.periodMonth}
           AND (s.paid_flag = false OR EXISTS (SELECT 1 FROM undone u WHERE u.schedule_row_id = s.id OR u.schedule_row_id IS NULL))
         ORDER BY s.sequence
         LIMIT 1
      ) s ON true
     WHERE l.id = ${loan.loanId}::uuid AND l.company_id = ${loan.companyId}::uuid
       AND (l.status = 'active' OR (l.status = 'settled' AND EXISTS (SELECT 1 FROM undone)))
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const instalment = round2(Number(r.interest) + Number(r.principal));
  if (instalment <= 0) return null;
  const fringeBenefit = fringeBenefitOf(loan.officialRate, Number(r.annual_interest_rate), Number(r.opening_balance));
  return {
    loanId: String(r.id), loanNumber: String(r.loan_number), employeeId: String(r.employee_id),
    employeeNumber: String(r.employee_number), instalment, fringeBenefit,
    missing: fringeBenefit > 0 && !present.fringe ? ['deduction', 'fringe'] : ['deduction'],
  };
}

const groupBy = <T>(items: T[], key: (t: T) => string) => {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
};

const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** One blocking line result per employee, naming each withheld loan at what it would take and every missing component. */
export function withheldLineResults(withheld: WithheldLoan[]): Map<string, ValidationResult[]> {
  const ordered = [...withheld].sort((a, b) => a.loanNumber.localeCompare(b.loanNumber));
  return new Map([...groupBy(ordered, (w) => w.employeeId)].map(([employeeId, loans]) => {
    const fringe = loans.some((w) => w.missing.includes('fringe'));
    const several = loans.length > 1;
    const missing = `no active deduction coded LOAN${fringe ? ' and no active earning coded 3801 for the low-interest fringe benefit' : ''}`;
    const each = loans.map((w) => `${w.loanNumber} (instalment ${formatMoney(w.instalment)}`
      + `${w.missing.includes('fringe') ? `, fringe benefit ${formatMoney(w.fringeBenefit)}` : ''})`);
    return [employeeId, [{
      code: 'LOAN_DEDUCTION_MISSING',
      severity: 'error',
      loans: loans.map((w) => w.loanNumber),
      missing: fringe ? ['LOAN', '3801'] : ['LOAN'],
      message: `${several ? 'Loans' : 'Loan'} ${listed(each)}: ${missing}, so the ${several ? 'instalments were' : 'instalment was'} not taken `
        + `and the ${several ? 'loans are' : 'loan is'} unchanged. Add the missing ${fringe ? 'components' : 'component'} under Setup → Pay Components, `
        + 'then recalculate.',
    } satisfies ValidationResult]];
  }));
}

/** A loan collected with a fringe benefit no 3801 earning carries: a warning naming the loan (Hein). */
export function fringeNotRecordedResults(applied: Map<string, ApplyLoanResult[]>, components: LoanComponents): Map<string, ValidationResult> {
  const out = new Map<string, ValidationResult>();
  if (components.fringe) return out;
  for (const [employeeId, apps] of applied) {
    const missed = apps.filter((a) => a.fringeBenefit > 0);
    if (missed.length === 0) continue;
    out.set(employeeId, {
      code: 'LOAN_FRINGE_NOT_RECORDED',
      severity: 'warning',
      loans: missed.map((a) => a.loanNumber),
      message: `${missed.length > 1 ? 'Loans' : 'Loan'} ${listed(missed.map((a) => `${a.loanNumber} (fringe benefit ${formatMoney(a.fringeBenefit)})`))}: `
        + `the ${missed.length > 1 ? 'instalments were' : 'instalment was'} taken, but no active earning is coded 3801, so the low-interest fringe `
        + `${missed.length > 1 ? 'benefits are' : 'benefit is'} not on the payslip and not taxed. Add one under Setup → Pay Components and recalculate.`,
    });
  }
  return out;
}

/** What a calculation of this run would withhold, read only (MCP calculate_pay_run, live and dry). */
export async function previewWithheldLoans(
  companyId: string, runId: string, period: { year: number; month: number }, officialRate: number,
): Promise<WithheldLoan[]> {
  const components = await loadLoanComponents(companyId);
  const present = { deduction: components.deduction != null, fringe: components.fringe != null };
  if (present.deduction) return [];
  const employees = new Set((await listPayrollRunEmployees(companyId, period)).map((e) => e.id));
  const due = (await sql`
    SELECT DISTINCT l.id AS loan_id, l.employee_id
      FROM payroll_loans l
      JOIN payroll_loan_schedule s ON s.loan_id = l.id
     WHERE l.company_id = ${companyId}::uuid
       AND s.due_period_year = ${period.year} AND s.due_period_month = ${period.month}
  `) as DbRow[];
  const out: WithheldLoan[] = [];
  for (const row of due) {
    if (!employees.has(String(row.employee_id))) continue;
    const held = await withholdingFor({ loanId: String(row.loan_id), companyId, runId, periodYear: period.year, periodMonth: period.month, officialRate }, present);
    if (held) out.push(held);
  }
  return out.sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber) || a.loanNumber.localeCompare(b.loanNumber));
}

/** The loans a calculation of this run does not take, as the MCP calculate_pay_run reports them. */
export async function withheldLoansReport(companyId: string, run: { id: string; periodYear: number; periodMonth: number }) {
  const held = await previewWithheldLoans(companyId, run.id, { year: run.periodYear, month: run.periodMonth }, runOfficialRate());
  return held.map((w) => ({
    employee_number: w.employeeNumber,
    loan_number: w.loanNumber,
    instalment: w.instalment,
    missing: w.missing.map((m) => (m === 'deduction' ? 'LOAN deduction' : '3801 earning')),
  }));
}

/** The run's official rate, as calculatePayrollRun reads it. */
export const runOfficialRate = () => Number(process.env.SARS_OFFICIAL_RATE ?? 0.085);
