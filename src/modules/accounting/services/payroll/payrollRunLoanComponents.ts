/**
 * Loan impact on a payslip: the instalment as a deduction and the low-interest
 * fringe benefit as an earning. Extracted from payrollRunService to keep that
 * file under the 300-line cap.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { EmployeeComponent, PayrollComponent } from './payrollTypes';
import type { ApplyLoanResult } from './payrollLoanService';

type Row = DbRow;

/**
 * Resolves the SARS-coded payroll components used to represent loan impact
 * on a payslip:
 *   - code 'LOAN'  : earner-facing deduction for principal + interest.
 *   - code '3801'  : taxable fringe benefit (low-interest loan).
 * Callers pre-seed these components under Setup → Pay Components. Loans
 * silently skip the row if the component doesn't exist (the payment is
 * still recorded on payroll_loan_payments, just not shown on payslip
 * until the admin adds the component).
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
       AND sars_source_code IN ('LOAN', '3801')
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
    if (component.sarsSourceCode === 'LOAN') deduction = component;
    if (component.sarsSourceCode === '3801') fringe = component;
  }
  return { deduction, fringe };
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
