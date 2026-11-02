/**
 * Loan impact on a payslip: the instalment as a deduction and the low-interest
 * fringe benefit as an earning. Extracted from payrollRunService to keep that
 * file under the 300-line cap.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent, PayrollComponent, PayrollPeriod, ValidationResult } from './payrollTypes';
import type { ApplyLoanResult } from './payrollLoanService';

type Row = DbRow;

/**
 * Resolves the SARS-coded payroll components used to represent loan impact
 * on a payslip:
 *   - code 'LOAN'  : earner-facing deduction for principal + interest.
 *   - code '3801'  : taxable fringe benefit (low-interest loan).
 * Only a deduction can carry the instalment: a LOAN-coded earning would add it to gross pay.
 * LOAN is matched after the calculator's trim (normaliseSarsCode). Callers pre-seed these
 * components under Setup → Pay Components. With no LOAN deduction the run takes no
 * instalment at all (hasLoanDeduction, applyRunLoans) and the line says so
 * (withheldLoanInstalments); it used to record the payment with nothing on the payslip.
 */
async function loadLoanComponents(companyId: string): Promise<{
  deduction: PayrollComponent | null;
  fringe: PayrollComponent | null;
}> {
  const rows = (await sql`
    SELECT id, name, sars_source_code, component_type,
           is_taxable, is_uif_applicable, is_sdl_applicable
      FROM payroll_components
     WHERE company_id = ${companyId}::uuid
       AND is_active = true
       AND ((BTRIM(sars_source_code, E' \t\r\n') = 'LOAN' AND component_type = 'deduction') OR sars_source_code = '3801')
     ORDER BY created_at, id
  `) as Row[];

  let deduction: PayrollComponent | null = null;
  let fringe: PayrollComponent | null = null;
  for (const r of rows) {
    const component: PayrollComponent = {
      id: String(r.id),
      name: String(r.name),
      sarsSourceCode: String(r.sars_source_code),
      componentType: r.component_type as PayrollComponent['componentType'],
      isTaxable: r.is_taxable === true,
      isUifApplicable: r.is_uif_applicable === true,
      isSdlApplicable: r.is_sdl_applicable === true,
    };
    // The first made of each, so the same one is used on every calculation.
    if (normaliseSarsCode(component.sarsSourceCode) === 'LOAN') deduction ??= component;
    if (component.sarsSourceCode === '3801') fringe ??= component;
  }
  return { deduction, fringe };
}

/** Whether a run can put a loan instalment on a payslip. Asked before any loan is applied. */
export async function hasLoanDeduction(companyId: string): Promise<boolean> {
  return (await loadLoanComponents(companyId)).deduction != null;
}

/**
 * The instalments a run did not take for want of a LOAN deduction, as one blocking line result per
 * employee (LOAN_DEDUCTION_MISSING, read by the approval gate). Call after applyRunLoans, whose
 * reversal has unflagged this run's own schedule rows.
 */
export async function withheldLoanInstalments(
  companyId: string,
  period: PayrollPeriod,
  employeeIds: string[],
): Promise<Map<string, ValidationResult>> {
  const rows = (await sql`
    SELECT l.employee_id, l.loan_number, SUM(s.installment)::float8 AS due
      FROM payroll_loans l
      JOIN payroll_loan_schedule s ON s.loan_id = l.id
     WHERE l.company_id = ${companyId}::uuid
       AND l.status = 'active'
       AND l.employee_id = ANY(${employeeIds}::uuid[])
       AND s.due_period_year = ${period.year}
       AND s.due_period_month = ${period.month}
       AND s.paid_flag = false
       AND s.installment > 0
     GROUP BY l.employee_id, l.loan_number
     ORDER BY l.loan_number
  `) as Row[];
  const byEmployee = new Map<string, Array<{ loan: string; due: number }>>();
  for (const r of rows) {
    const list = byEmployee.get(String(r.employee_id)) ?? [];
    list.push({ loan: String(r.loan_number), due: Number(r.due) });
    byEmployee.set(String(r.employee_id), list);
  }
  return new Map([...byEmployee].map(([employeeId, due]) => [employeeId, {
    code: 'LOAN_DEDUCTION_MISSING',
    severity: 'error',
    loans: due.map((d) => d.loan),
    message: `Loan ${due.map((d) => `${d.loan} (${formatMoney(d.due)})`).join(', ')} is due, but no active deduction is coded LOAN to take it on, `
      + 'so nothing was taken and the loan is unchanged. Add one under Setup → Pay Components, then recalculate.',
  }]));
}

export async function appendLoanComponents(
  companyId: string,
  components: EmployeeComponent[],
  loanApplications: ApplyLoanResult[],
): Promise<EmployeeComponent[]> {
  if (loanApplications.length === 0) return components;

  const { deduction, fringe } = await loadLoanComponents(companyId);
  const injected: EmployeeComponent[] = [];

  for (const app of loanApplications) {
    const repayment = app.interest + app.principal;
    if (repayment > 0 && deduction) {
      injected.push({ component: deduction, amount: repayment });
    }
    if (app.fringeBenefit > 0 && fringe) {
      injected.push({ component: fringe, amount: app.fringeBenefit });
    }
  }

  if (injected.length > 0) {
    log.info('Loan components injected into payroll run', {
      companyId, count: injected.length,
    }, 'payrollRunLoanComponents');
  }

  return [...components, ...injected];
}
