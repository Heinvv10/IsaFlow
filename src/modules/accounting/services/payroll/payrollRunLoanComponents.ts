/**
 * Loan impact on a payslip: the instalment as a deduction and the low-interest
 * fringe benefit as an earning. Extracted from payrollRunService to keep that
 * file under the 300-line cap.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent, PayrollComponent } from './payrollTypes';
import type { ApplyLoanResult } from './payrollLoanService';

type Row = DbRow;

/** The components a run shows loans with, resolved once per calculation. */
export interface LoanComponents {
  deduction: PayrollComponent | null;
  fringe: PayrollComponent | null;
}

/**
 * The components a payslip shows a loan with: the instalment (principal + interest) on an active
 * DEDUCTION coded LOAN, the low-interest fringe benefit on an active taxable EARNING coded 3801, each the
 * first made (`ORDER BY created_at, id`), codes compared after the calculator's trim
 * (normaliseSarsCode). A LOAN-coded earning would add the instalment to gross pay. With no LOAN
 * deduction a loan is not taken at all (payrollLoanWithholding); it used to be recorded on the
 * loan with nothing on the payslip. With no 3801 earning it is taken and the line warns. Setup → Pay Components creates both
 * (POST /api/payroll/loans/setup-components).
 */
export async function loadLoanComponents(companyId: string): Promise<LoanComponents> {
  const rows = (await sql`
    SELECT id, name, sars_source_code, component_type,
           is_taxable, is_uif_applicable, is_sdl_applicable
      FROM payroll_components
     WHERE company_id = ${companyId}::uuid
       AND is_active = true
       AND ((BTRIM(sars_source_code, E' \t\r\n') = 'LOAN' AND component_type = 'deduction')
         OR (BTRIM(sars_source_code, E' \t\r\n') = '3801' AND component_type = 'earning' AND is_taxable = true))
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
    if (normaliseSarsCode(component.sarsSourceCode) === 'LOAN') deduction ??= component;
    if (normaliseSarsCode(component.sarsSourceCode) === '3801') fringe ??= component;
  }
  return { deduction, fringe };
}

/**
 * The applied loans on the payslip. Refuses, never skips, a repayment with no LOAN deduction to carry
 * it: the loan has already moved, so a payslip without it would put the subledger and the GL apart.
 * The run withholds such a loan before applying it, so this is the backstop. A fringe benefit with
 * no 3801 earning is left off and warned about (Hein).
 */
export function appendLoanComponents(
  components: EmployeeComponent[],
  loanApplications: ApplyLoanResult[],
  loanComponents: LoanComponents,
): EmployeeComponent[] {
  const injected: EmployeeComponent[] = [];
  for (const app of loanApplications) {
    const repayment = app.interest + app.principal;
    if (repayment > 0) {
      if (!loanComponents.deduction) throw new Error(`Loan ${app.loanNumber} was applied with no active deduction coded LOAN to show it on`);
      injected.push({ component: loanComponents.deduction, amount: repayment });
    }
    // No 3801 earning: the loan is collected and the line warns (fringeNotRecordedResults, Hein).
    if (app.fringeBenefit > 0 && loanComponents.fringe) {
      injected.push({ component: loanComponents.fringe, amount: app.fringeBenefit, isNonCash: true });
    }
  }
  if (injected.length > 0) {
    log.info('Loan components injected into payroll run', { count: injected.length }, 'payrollRunLoanComponents');
  }
  return [...components, ...injected];
}
