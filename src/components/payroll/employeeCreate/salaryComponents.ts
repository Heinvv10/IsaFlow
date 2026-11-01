/** Which pay components can carry a new employee's salary. The server applies the same rule (payrollEmployeeOnboarding). */
import { normaliseSarsCode, payeTreatment } from '@/modules/accounting/services/payroll/payeAnnualPayment';

export interface SalaryComponent {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: string;
}

/** Monthly earnings: an annual payment or a lump sum is not a recurring salary. */
export const salaryComponents = (all: SalaryComponent[]) =>
  all.filter(c => c.componentType === 'earning' && payeTreatment(c.sarsSourceCode) === 'periodic');

const isBasicSalary = (c: SalaryComponent) => normaliseSarsCode(c.sarsSourceCode) === '3601';
export const hasBasicSalary = (eligible: SalaryComponent[]) => eligible.some(isBasicSalary);

/** The Basic Salary component, only when there is exactly one: with two, choosing for the user would be a guess. */
export function defaultSalaryComponent(eligible: SalaryComponent[]): string | null {
  const basics = eligible.filter(isBasicSalary);
  return basics.length === 1 ? basics[0]!.id : null;
}
