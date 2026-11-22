/** Shared by the off-cycle line tests (offCycleMonthLine, offCycleMonthClassification): one employee, earnings and lines. */
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { MonthEarlierLines } from '@/modules/accounting/services/payroll/payrollOffCycleMonth';
import type { EmployeeComponent, PayeYearToDate, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

export const employee = (over: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'co', employeeNumber: 'E1', firstName: 'Young', lastName: 'Worker', employmentType: 'permanent',
  startDate: new Date(2026, 0, 1), dateOfBirth: new Date(2004, 5, 1), idNumber: '0406015009086', uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: 40, ...over,
});
export const earning = (id: string, code: string, amount: number): EmployeeComponent => ({
  component: { id, name: code, sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true }, amount,
});
export const period = { month: 3, year: 2026 };
export const regularLine = (salary: number, e = employee()) => calculatePayrollLine({
  employee: e, components: [earning('basic', '3601', salary)], period, taxYear: 2027, annualPayrollEstimate: 1_000_000,
});
/** The month's earlier lines as the reader gives them: the regular line's stored figures and its earnings. */
export const earlierFrom = (r: ReturnType<typeof regularLine>, salary: number): MonthEarlierLines => ({
  uifRemuneration: salary, eti: r.eti.monthlyEti,
  etiComponents: [earning('basic', '3601', salary)],
});
export const bonusLine = (bonus: number, earlier: MonthEarlierLines, ytd?: PayeYearToDate, e = employee()) => calculatePayrollLine({
  employee: e, components: [earning('bonus', '3605', bonus)], period, taxYear: 2027, annualPayrollEstimate: 1_000_000,
  monthEarlier: earlier, ...(ytd ? { ytd } : {}),
});
