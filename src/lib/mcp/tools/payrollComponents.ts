/**
 * MCP read tools: pay components, and one employee's assignments.
 *
 * These exist to make the WRITE surface usable. `assign_employee_component`
 * takes a `component_id` and `end_employee_component` takes an `assignment_id`,
 * and without a way to read either an agent would have to guess a UUID. They
 * are the payroll equivalent of `list_gl_accounts` before a journal.
 *
 * `get_employee` is here for the same reason: `list_employees` pages a company
 * and answers "who is there", but after creating or updating one an agent needs
 * to read that single record back, which a paged list makes awkward.
 */
import type { McpTool } from '../types';
import { listComponents } from '@/modules/accounting/services/payroll/payrollComponentService';
import { listEmployeeComponentAssignments } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { getPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const listPayrollComponentsTool: McpTool = {
  name: 'list_payroll_components',
  description:
    'The pay components this company can assign to an employee — basic salary, allowances, '
    + 'deductions, employer contributions. Resolve component_id here before calling '
    + 'assign_employee_component. Each carries the SARS source code it reports under and '
    + 'whether it is taxable and subject to UIF and SDL, which is what drives the engines.',
  scope: 'read:payroll',
  write: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const components = await listComponents(ctx.companyId);
    return ok({
      count: components.length,
      components: components.map((c) => ({
        id: c.id,
        name: c.name,
        sars_source_code: c.sarsSourceCode,
        component_type: c.componentType,
        is_taxable: c.isTaxable,
        is_uif_applicable: c.isUifApplicable,
        is_sdl_applicable: c.isSdlApplicable,
      })),
    });
  },
};

export const listEmployeeComponentsTool: McpTool = {
  name: 'list_employee_components',
  description:
    "One employee's pay components, with the assignment_id that end_employee_component takes. "
    + 'An employee with nothing here is paid NOTHING — the run costs earnings from these, so '
    + 'check this before costing a run rather than after wondering why gross is zero. '
    + 'Closed assignments are included: an ended component explains a past run.',
  scope: 'read:payroll',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { employee_id: { type: 'string' } },
    required: ['employee_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const employeeId = strArg(args, 'employee_id');
    if (!employeeId) return toolError('employee_id is required');
    const bad = guardCastableArgs(args, { uuid: ['employee_id'] });
    if (bad) return bad;

    // Company scope comes from the employee read; the assignment table carries
    // no company_id of its own, so reaching it by employee id alone would be an
    // unscoped read.
    const employee = await getPayrollEmployee(employeeId, ctx.companyId);
    if (!employee) return toolError(NOT_FOUND);

    const assignments = await listEmployeeComponentAssignments(ctx.companyId, employeeId);
    return ok({
      employee_id: employeeId,
      employee_number: employee.employeeNumber,
      count: assignments.length,
      assignments: assignments.map((a) => ({
        assignment_id: a.id,
        component_id: a.componentId,
        amount: a.amount,
        effective_from: a.effectiveFrom,
        effective_to: a.effectiveTo,
        is_recurring: a.isRecurring,
      })),
    });
  },
};

export const getEmployeeTool: McpTool = {
  name: 'get_employee',
  description:
    'One payroll employee by id. Use after create_employee or update_employee to read the '
    + 'record back, and before assign_employee_component to confirm you have the right person.',
  scope: 'read:payroll',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { employee_id: { type: 'string' } },
    required: ['employee_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const employeeId = strArg(args, 'employee_id');
    if (!employeeId) return toolError('employee_id is required');
    const bad = guardCastableArgs(args, { uuid: ['employee_id'] });
    if (bad) return bad;

    const employee = await getPayrollEmployee(employeeId, ctx.companyId);
    if (!employee) return toolError(NOT_FOUND);

    return ok({
      id: employee.id,
      employee_number: employee.employeeNumber,
      first_name: employee.firstName,
      last_name: employee.lastName,
      employment_type: employee.employmentType,
      id_number: employee.idNumber ?? null,
      tax_number: employee.taxNumber ?? null,
      start_date: employee.startDate.toISOString().slice(0, 10),
      end_date: employee.endDate ? employee.endDate.toISOString().slice(0, 10) : null,
      date_of_birth: employee.dateOfBirth ? employee.dateOfBirth.toISOString().slice(0, 10) : null,
      uif_excluded: employee.uifExcluded,
      medical_aid_main_member: employee.medicalAidMainMember,
      medical_aid_dependants_count: employee.medicalAidDependantsCount,
      cost_centre_id: employee.costCentreId ?? null,
    });
  },
};
