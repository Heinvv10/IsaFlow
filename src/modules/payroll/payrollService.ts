/**
 * Payroll Service — coordinator and re-export facade.
 * Consumers import from here for backward compatibility.
 *
 * Implementation is split into:
 *   payrollEmployeeService.ts  — employee CRUD + pay history
 *   payrollRunService.ts       — run creation, calculation, finalization
 *   payrollMappers.ts          — pure row-to-type mappers
 */

export {
  listEmployees,
  getEmployee,
  getEmployeePayHistory,
  getEmployeePayslips,
  createEmployee,
  updateEmployee,
} from './payrollEmployeeService';

export {
  listPayrollRuns,
  getPayrollRun,
  createPayrollRun,
  completePayrollRun,
  reversePayrollRun,
} from './payrollRunService';

export {
  mapEmployeeWithPay,
  mapPayStructure,
  mapPayrollRun,
  mapPayslip,
} from './payrollMappers';
