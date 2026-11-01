/**
 * One step from "new employee" to "ready to pay": the employee and their salary, in the request transaction.
 *
 * Everything is judged before the first write. withAuth COMMITs a 4xx, so EmployeeOnboardingRefused is only ever
 * thrown before createPayrollEmployee; a failure after it stays a plain error, so the request answers 500 and rolls
 * the employee back. The caller answers EmployeeOnboardingRefused as a 400 and rethrows the rest.
 *
 * The body is integer cents (what MoneyField hands over); payroll_employee_components.amount is rands.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isRealCalendarDate, isUuidParam } from '@/lib/validation';
import { isValidSaIdNumber, isValidSarsTaxNumber } from './irp5ValidationEngine';
import { payeTreatment } from './payeAnnualPayment';
import { assignComponentToEmployee } from './payrollEmployeeComponentService';
import { createPayrollEmployee } from './payrollEmployeeService';
import type { PayrollEmployee } from './payrollTypes';

const EMPLOYMENT_TYPES: readonly string[] = ['permanent', 'contract', 'casual', 'director'];
/** payroll_employee_components.amount is NUMERIC(14,2). */
const MAX_SALARY_CENTS = 99_999_999_999_999;
const MAX_DEPENDANTS = 100;

export class EmployeeOnboardingRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeOnboardingRefused';
  }
}

type Body = Record<string, unknown>;
type NewEmployee = Omit<PayrollEmployee, 'id' | 'companyId'>;
interface Salary { componentId: string; cents: number }

const isBlank = (v: unknown) => v === undefined || v === null || v === '';

function requiredText(body: Body, key: string, maxLength: number): string {
  const value = body[key];
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new EmployeeOnboardingRefused(`${key} is required`);
  if (text.length > maxLength) throw new EmployeeOnboardingRefused(`${key} must be at most ${maxLength} characters`);
  return text;
}

/**
 * UTC midnight, as `new Date('YYYY-MM-DD')` gives: createPayrollEmployee reads it through fmtDate (local getters) and
 * assignComponentToEmployee through toISOString, and on this UTC+2 host only UTC midnight is the same day in both.
 */
function dateOf(value: unknown, key: string): Date {
  if (typeof value !== 'string' || !isRealCalendarDate(value)) throw new EmployeeOnboardingRefused(`${key} must be a real date (YYYY-MM-DD)`);
  return new Date(value);
}
const optionalDate = (body: Body, key: string) => (isBlank(body[key]) ? undefined : dateOf(body[key], key));

function identifier(value: unknown, isValid: (v: string) => boolean, refusal: string): string | undefined {
  if (isBlank(value)) return undefined;
  if (typeof value !== 'string' || !isValid(value)) throw new EmployeeOnboardingRefused(refusal);
  return value.trim();
}

const TAX_REFUSAL = 'SARS tax number must be 10 digits starting with 0, 1, 2, 3 or 9';
const ID_REFUSAL = 'SA ID number must be 13 digits';

function dependantsOf(value: unknown): number {
  if (isBlank(value)) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_DEPENDANTS) {
    throw new EmployeeOnboardingRefused('Medical aid dependants must be a whole number of 0 or more');
  }
  return value;
}

function employeeOf(body: Body): NewEmployee {
  const employmentType = body.employmentType;
  if (typeof employmentType !== 'string' || !EMPLOYMENT_TYPES.includes(employmentType)) {
    throw new EmployeeOnboardingRefused(`employmentType must be one of: ${EMPLOYMENT_TYPES.join(', ')}`);
  }
  return {
    firstName: requiredText(body, 'firstName', 100),
    lastName: requiredText(body, 'lastName', 100),
    employeeNumber: requiredText(body, 'employeeNumber', 20),
    employmentType: employmentType as PayrollEmployee['employmentType'],
    startDate: dateOf(body.startDate, 'startDate'),
    endDate: optionalDate(body, 'endDate'),
    taxNumber: identifier(body.taxNumber, isValidSarsTaxNumber, TAX_REFUSAL),
    idNumber: identifier(body.idNumber, isValidSaIdNumber, ID_REFUSAL),
    dateOfBirth: optionalDate(body, 'dateOfBirth'),
    uifExcluded: Boolean(body.uifExcluded),
    // Only an explicit true makes a main member: the flag buys a monthly medical tax credit,
    // so a default of true under-deducts PAYE for everyone captured without medical aid.
    medicalAidMainMember: body.medicalAidMainMember === true,
    medicalAidDependantsCount: dependantsOf(body.medicalAidDependantsCount),
  };
}

function salaryOf(raw: unknown): Salary | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new EmployeeOnboardingRefused('salary must be { componentId, amount }');
  const { componentId, amount } = raw as Body;
  if (!isUuidParam(componentId)) throw new EmployeeOnboardingRefused('salary.componentId must be a pay component id');
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_SALARY_CENTS) {
    throw new EmployeeOnboardingRefused('salary.amount must be a positive number of whole cents');
  }
  return { componentId, cents: amount };
}

/** The same answer for another company's component as for one that does not exist. */
async function assertSalaryComponent(companyId: string, componentId: string): Promise<void> {
  const rows = (await sql`
    SELECT sars_source_code, component_type, is_active FROM payroll_components
    WHERE id = ${componentId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  const component = rows[0];
  if (!component) throw new EmployeeOnboardingRefused('That pay component was not found in this company');
  if (!component.is_active) throw new EmployeeOnboardingRefused('That pay component is inactive');
  if (component.component_type !== 'earning') throw new EmployeeOnboardingRefused('A salary must be an earning component');
  // A recurring 3605 or 39xx would be taxed as a lump of the year every month. Monthly pay is 'periodic'.
  if (payeTreatment(String(component.sars_source_code)) !== 'periodic') {
    throw new EmployeeOnboardingRefused('A salary must be a monthly earning, not an annual payment or a lump sum');
  }
}

async function assertEmployeeNumberFree(companyId: string, employeeNumber: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
    WHERE company_id = ${companyId}::uuid AND employee_number = ${employeeNumber}
  `) as DbRow[];
  if (rows.length > 0) throw new EmployeeOnboardingRefused(`Employee number ${employeeNumber} is already in use`);
}

function changedIdentifier(value: unknown, stored: string | undefined, isValid: (v: string) => boolean, refusal: string): unknown {
  return isBlank(value) || value === stored ? value : identifier(value, isValid, refusal);
}

/**
 * The PATCH body with its tax and ID numbers judged as create judges them; raises EmployeeOnboardingRefused before the
 * update. The profile form resends both on every save, so a number already stored (older rows hold values the rule
 * refuses) is left alone: refusing it would block every other edit to that employee.
 */
export function employeeChangesOf<T extends Body>(body: T, current: Pick<PayrollEmployee, 'taxNumber' | 'idNumber'>): T {
  return {
    ...body,
    taxNumber: changedIdentifier(body.taxNumber, current.taxNumber, isValidSarsTaxNumber, TAX_REFUSAL),
    idNumber: changedIdentifier(body.idNumber, current.idNumber, isValidSaIdNumber, ID_REFUSAL),
  };
}

/** `salary` in the body is optional: without it the employee is created with no pay, as before. */
export async function createEmployeeWithPay(companyId: string, userId: string, body: Body): Promise<PayrollEmployee> {
  const fields = employeeOf(body);
  const salary = salaryOf(body.salary);
  await assertEmployeeNumberFree(companyId, fields.employeeNumber);
  if (salary) await assertSalaryComponent(companyId, salary.componentId);

  const employee = await createPayrollEmployee(companyId, fields);
  if (salary) {
    await assignComponentToEmployee(companyId, employee.id, salary.componentId, salary.cents / 100, fields.startDate, undefined, true);
  }
  log.info('Employee onboarded', { companyId, employeeId: employee.id, userId, withSalary: salary !== null }, 'payrollEmployeeOnboarding');
  return employee;
}
