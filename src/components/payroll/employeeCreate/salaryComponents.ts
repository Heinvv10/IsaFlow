/** Which pay components can carry a new employee's salary. The server applies the same rule (payrollEmployeeOnboarding). */
import { normaliseSarsCode, payeTreatment } from '@/modules/accounting/services/payroll/payeAnnualPayment';

export interface SalaryComponent {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: string;
  isTaxable: boolean;
}

/** Taxable monthly earnings: an annual payment or a lump sum is not a recurring salary, and a non-taxable one deducts no PAYE. */
export const salaryComponents = (all: SalaryComponent[]) =>
  all.filter(c => c.componentType === 'earning' && c.isTaxable && payeTreatment(c.sarsSourceCode) === 'periodic');

const isBasicSalary = (c: SalaryComponent) => normaliseSarsCode(c.sarsSourceCode) === '3601';
export const hasBasicSalary = (eligible: SalaryComponent[]) => eligible.some(isBasicSalary);

/** The Basic Salary component, only when there is exactly one: with two, choosing for the user would be a guess. */
export function defaultSalaryComponent(eligible: SalaryComponent[]): string | null {
  const basics = eligible.filter(isBasicSalary);
  return basics.length === 1 ? basics[0]!.id : null;
}

/**
 * What the first pay run does with this start date. The run reads components once a month, as at the 27th, and does
 * not apportion (employee-create-with-pay.int.test.ts pins both), so the person capturing the salary has to be told.
 * Dates are ISO 'YYYY-MM-DD'.
 */
export function firstMonthNotes(startDate: string, today: string): string[] {
  const day = Number(startDate.slice(8, 10));
  const notes: string[] = [];
  if (day >= 28) notes.push("A start on the 28th or later gets no salary in that month's run: it is first paid next month.");
  else if (day > 1) notes.push('The first pay run pays the full monthly salary: it is not reduced for a mid-month start.');
  if (startDate.slice(0, 7) < today.slice(0, 7)) {
    notes.push('This start date is in an earlier month: runs already made are not changed, and back pay is not added for you.');
  }
  return notes;
}
