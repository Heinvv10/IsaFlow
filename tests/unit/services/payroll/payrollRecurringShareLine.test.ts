/**
 * W29 (wave 7 PRA): an apportioned row reaches the stored line and the payslip. The breakdown item carries the share
 * (payrollLineAccumulate), the payslip line prints it (payslipItems), and the loan preview (judgeLoanApplications, the
 * second calculatePayrollLine caller) costs the same prepared components as the stored line, so they agree.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { apportionRecurringRows } from '@/modules/accounting/services/payroll/payrollRecurringShare';
import { judgeLoanApplications } from '@/modules/accounting/services/payroll/payrollRunLoanDecision';
import { itemisePayslip } from '@/modules/accounting/services/payroll/payslipItems';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const employee: PayrollEmployee = {
  id: 'e1', companyId: 'c1', employeeNumber: 'E1', firstName: 'Share', lastName: 'Test', employmentType: 'permanent',
  startDate: new Date(2020, 0, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: null, hoursPerDay: null, dailyRate: null,
  hourlyRate: null, payFrequency: 'monthly',
} as PayrollEmployee;
const earning = (id: string, amount: number, effectiveFrom: string, effectiveTo: string | null = null): EmployeeComponent => ({
  component: { id, name: id === 'old' ? 'Basic Salary' : 'Standby allowance', sarsSourceCode: '3601', componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true },
  amount, isRecurring: true, effectiveFrom, effectiveTo,
});
const july = { year: 2026, month: 7 };
const prepared = apportionRecurringRows([earning('old', 4000, '2020-01-01'), earning('new', 2100, '2026-07-16')], employee, july);
const input = { employee, components: prepared, period: july, taxYear: 2027, annualPayrollEstimate: 10_000_000 as const };

describe('an apportioned row on the line', () => {
  const line = calculatePayrollLine(input);
  it('gross takes the share; the breakdown item carries it', () => {
    expect(line.grossPay).toBe(5095.65);
    expect(line.componentBreakdown.find(i => i.componentId === 'new')).toMatchObject({
      amount: 1095.65, share: { days: 12, of: 23, basis: 'working_days', fullAmount: 2100 },
    });
    expect(line.componentBreakdown.find(i => i.componentId === 'old')!.share).toBeUndefined();
  });

  it('the payslip line says the share; the whole row says nothing', () => {
    const slip = itemisePayslip({ grossPay: line.grossPay, paye: line.paye.monthlyPaye, uifEmployee: line.uif.employeeContribution,
      uifEmployer: line.uif.employerContribution, sdl: line.sdl, netPay: line.netPay, breakdown: line.componentBreakdown },
    new Map([['old', 'earning'], ['new', 'earning']]));
    expect(slip.earnings.map(e => e.label)).toEqual(['Basic Salary', 'Standby allowance, 12 of 23 working days (0.5217)']);
    expect(slip.notItemised).toBe(false);
  });

  it('a malformed stored share prints the plain name', () => {
    const slip = itemisePayslip({ grossPay: 10, paye: 0, uifEmployee: 0, uifEmployer: 0, sdl: 0, netPay: 10,
      breakdown: [{ componentId: 'new', componentName: 'Allowance', sarsSourceCode: '3601', amount: 10, isTaxable: true, isUifApplicable: true, share: { days: 'x' } }] },
    new Map([['new', 'earning']]));
    expect(slip.earnings.map(e => e.label)).toEqual(['Allowance']);
  });

  it('the loan preview costs the same components as the stored line (preview = stored)', () => {
    const stored = calculatePayrollLine({ ...input, annualPayrollEstimate: 'defer' });
    const preview = judgeLoanApplications({
      basis: { employee, components: prepared }, applications: [], loanComponents: { deduction: null, fringe: null },
      period: july, taxYear: 2027,
    });
    expect(preview.rawNet).toBe(stored.netPay);
    expect(stored.grossPay).toBe(5095.65);
  });
});
