/**
 * What a role that cannot write payroll may see of an employee: who they are,
 * nothing about them. ID / tax numbers, date of birth, dates of service,
 * medical aid, cost centre and pay scale stay with the write roles. Applied
 * server-side, in the route, so no client has to be trusted to hide a field.
 */
import type { PayrollEmployee } from './payrollTypes';

export type PayrollEmployeeNames = Pick<
  PayrollEmployee,
  'id' | 'companyId' | 'employeeNumber' | 'firstName' | 'lastName' | 'employmentType'
>;

export function employeeNamesOnly(e: PayrollEmployee): PayrollEmployeeNames {
  return {
    id: e.id,
    companyId: e.companyId,
    employeeNumber: e.employeeNumber,
    firstName: e.firstName,
    lastName: e.lastName,
    employmentType: e.employmentType,
  };
}
