import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { EmployeeComponent, PayrollComponent, PayrollPeriod } from './payrollTypes';
import { buildTerminationComponents, getTerminationDetails, getAnnualLeaveBalance, yearsOfService, type TerminationReason } from './payrollTerminationService';
import type { ApplyLoanResult } from './payrollLoanService';
type Row = DbRow;
export async function appendTerminationIfEndingThisPeriod(
  companyId: string,
  employee: { id: string; endDate?: Date; startDate: Date },
  components: EmployeeComponent[],
  period: PayrollPeriod,
): Promise<EmployeeComponent[]> {
  const { endDate, startDate } = employee;
  if (!endDate) return components;
  const endYear = endDate.getFullYear();
  const endMonth = endDate.getMonth() + 1;
  if (endYear !== period.year || endMonth !== period.month) return components;

  const details = await getTerminationDetails(companyId, employee.id);
  if (!details || !details.reason) return components;

  const monthlySalary = components
    .filter((c) => c.component.componentType === 'earning')
    .reduce((sum, c) => sum + c.amount, 0);
  if (monthlySalary <= 0) return components;

  const unusedLeaveDays = details.includeLeavePayout
    ? await getAnnualLeaveBalance(companyId, employee.id, period.year)
    : 0;

  const termination = buildTerminationComponents({
    monthlySalary,
    unusedLeaveDays,
    noticePeriodDays: details.noticePeriodDays ?? 0,
    servedNoticeDays: details.servedNoticeDays ?? 0,
    severanceWeeksPerYear: details.severanceWeeksPerYear ?? 0,
    yearsOfService: yearsOfService(
      startDate.toISOString().slice(0, 10),
      endDate.toISOString().slice(0, 10),
    ),
    includeLeavePayout: details.includeLeavePayout,
    reason: details.reason as TerminationReason,
  });

  if (termination.length > 0) {
    log.info('Termination components injected into payroll run', {
      companyId, employeeId: employee.id, period, count: termination.length,
    }, 'payrollRunService');
  }
  return [...components, ...termination];
}

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
    }, 'payrollRunService');
  }

  return [...components, ...injected];
}
