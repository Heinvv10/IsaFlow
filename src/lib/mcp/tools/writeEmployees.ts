/**
 * MCP write tools: payroll employees and their pay components.
 *
 * ── WHY THESE EXIST ─────────────────────────────────────────────────────────
 *
 * The connector could open a pay run and post its journal, but it could not
 * create the people the run is FOR. `create_pay_run` opens a period,
 * `post_payroll_journal` puts it in the ledger, and between them sat two steps
 * reachable only through the browser: making an employee, and giving that
 * employee something to be paid. An agent rebuilding a company's books from
 * source documents therefore stalled at the first pay run with nothing it could
 * do about it.
 *
 * ── AN EMPLOYEE WITHOUT COMPONENTS COSTS TO ZERO ────────────────────────────
 *
 * `calculatePayrollRun` reads earnings from `getEmployeeComponents`, not from
 * any field on the employee. So `create_employee` alone would let an agent
 * build a payroll of people who are all paid nothing, and the run would cost
 * cleanly to R0 without erroring — the worst kind of wrong, because it looks
 * like it worked. `assign_employee_component` is what makes an employee
 * payable, and the two belong in the same surface for that reason.
 *
 * Nothing here posts to the ledger. Creating an employee, assigning a salary
 * and ending a component are all subledger setup; the ledger is touched only by
 * `post_payroll_journal`, which is why none of these is `requiresPost`.
 */
import type { McpTool } from '../types';
import { fmtDate } from '@/lib/fmtDate';
import {
  createPayrollEmployee,
  getPayrollEmployee,
  updatePayrollEmployee,
} from '@/modules/accounting/services/payroll/payrollEmployeeService';
import type { EmploymentType } from '@/modules/accounting/services/payroll/payrollTypes';
import {
  isValidSaIdNumber,
  isValidSarsTaxNumber,
} from '@/modules/accounting/services/payroll/irp5ValidationEngine';
import { refuseEmployeeTermArgs } from './employeeTermsRefusal';
import { asDate } from './mcpDates';
import { NOT_FOUND, guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

const EMPLOYMENT_TYPES: readonly EmploymentType[] = ['permanent', 'contract', 'casual', 'director'];
/** What the schemas offer: a director is refused (employeeTermsRefusal), the tax status makes one. */
const SETTABLE_EMPLOYMENT_TYPES = EMPLOYMENT_TYPES.filter((t) => t !== 'director');

/*
 * The repo's OWN rules, not a local approximation. `isValidSarsTaxNumber` is
 * `/^[01239]\d{9}$/` — ten digits with a constrained leading digit — and a
 * plain `/^\d{10}$/` here accepted `4123456789`, which `irp5ValidationEngine`
 * then rejects at IRP5 time. That is exactly the "rejected months later by
 * someone who cannot tell which employee it came from" this check exists to
 * prevent, so the check has to be the same one.
 */

export { asDate };

export const createEmployeeTool: McpTool = {
  name: 'create_employee',
  description:
    'Create a payroll employee. Posts NOTHING to the ledger — this is subledger setup. '
    + 'An employee created here is paid NOTHING until assign_employee_component gives them a salary: '
    + 'the run costs earnings from components, not from the employee record, so a run over '
    + 'component-less employees costs cleanly to R0 rather than failing. '
    + 'employment_type is recorded for HR: permanent, contract or casual (director is refused: set the tax status to Director in the app). '
    + 'Tax status, pay basis, hours and rates are set in the app, not through this tool.',
  scope: 'write:payroll',
  requiresWriteRole: true,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      employee_number: { type: 'string', description: "The company's own employee number" },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      employment_type: { type: 'string', enum: [...SETTABLE_EMPLOYMENT_TYPES] },
      start_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      id_number: { type: 'string', description: 'SA ID number, 13 digits' },
      tax_number: { type: 'string', description: 'SARS tax reference, 10 digits' },
      date_of_birth: { type: 'string', format: 'date' },
      end_date: { type: 'string', format: 'date', description: 'Only for someone who has already left' },
      uif_excluded: { type: 'boolean', description: 'Default false. True only where UIF genuinely does not apply.' },
      medical_aid_main_member: { type: 'boolean' },
      medical_aid_dependants_count: { type: 'number', minimum: 0 },
      s18a_receipt_held: { type: 'boolean', description: 'The employer holds the s18A receipt: donations (4030) may reduce PAYE and SDL' },
      idempotency_key: { type: 'string' },
    },
    required: ['employee_number', 'first_name', 'last_name', 'employment_type', 'start_date', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const employeeNumber = strArg(args, 'employee_number')?.trim();
    const firstName = strArg(args, 'first_name')?.trim();
    const lastName = strArg(args, 'last_name')?.trim();
    const employmentType = strArg(args, 'employment_type');
    const startDate = strArg(args, 'start_date');

    if (!employeeNumber) return toolError('employee_number is required');
    if (!firstName) return toolError('first_name is required');
    if (!lastName) return toolError('last_name is required');
    if (!startDate) return toolError('start_date is required (YYYY-MM-DD)');
    if (!employmentType || !EMPLOYMENT_TYPES.includes(employmentType as EmploymentType)) {
      return toolError(`employment_type must be one of: ${EMPLOYMENT_TYPES.join(', ')}`);
    }

    const bad = guardCastableArgs(args, {
      date: ['start_date', 'end_date', 'date_of_birth'],
    }) ?? refuseEmployeeTermArgs(args);
    if (bad) return bad;

    // Shape-checked before the write, not after. Both reach SARS submissions
    // (EMP201, IRP5) where a malformed number is rejected months later by
    // someone who cannot tell which employee it came from.
    const idNumber = strArg(args, 'id_number');
    if (idNumber !== undefined && !isValidSaIdNumber(idNumber)) {
      return toolError('id_number must be 13 digits');
    }
    const taxNumber = strArg(args, 'tax_number');
    if (taxNumber !== undefined && !isValidSarsTaxNumber(taxNumber)) {
      return toolError('tax_number must be a valid SARS tax reference (10 digits, starting 0, 1, 2, 3 or 9)');
    }

    if (args.s18a_receipt_held !== undefined && typeof args.s18a_receipt_held !== 'boolean') {
      return toolError('s18a_receipt_held must be true or false');
    }

    const dependants = args.medical_aid_dependants_count;
    let dependantsCount = 0;
    if (dependants !== undefined && dependants !== null) {
      dependantsCount = Number(dependants);
      if (!Number.isInteger(dependantsCount) || dependantsCount < 0) {
        return toolError('medical_aid_dependants_count must be a whole number of 0 or more');
      }
    }

    const endDate = strArg(args, 'end_date');
    const dateOfBirth = strArg(args, 'date_of_birth');

    try {
      const employee = await createPayrollEmployee(ctx.companyId, {
        employeeNumber,
        firstName,
        lastName,
        employmentType: employmentType as EmploymentType,
        startDate: asDate(startDate),
        ...(endDate === undefined ? {} : { endDate: asDate(endDate) }),
        ...(dateOfBirth === undefined ? {} : { dateOfBirth: asDate(dateOfBirth) }),
        ...(idNumber === undefined ? {} : { idNumber }),
        ...(taxNumber === undefined ? {} : { taxNumber }),
        uifExcluded: args.uif_excluded === true,
        medicalAidMainMember: args.medical_aid_main_member === true,
        medicalAidDependantsCount: dependantsCount,
        s18aReceiptHeld: args.s18a_receipt_held === true,
      });
      return ok({
        id: employee.id,
        employee_number: employee.employeeNumber,
        first_name: employee.firstName,
        last_name: employee.lastName,
        employment_type: employee.employmentType,
        start_date: fmtDate(employee.startDate),
        next_step: 'assign_employee_component — until then this employee is paid nothing',
      });
    } catch (err) {
      // A duplicate employee_number surfaces here as a constraint violation and
      // generic-ifies rather than leaking the schema. Nothing was written.
      return toolError(safeErrorText(err, 'Failed to create employee.'));
    }
  },
};

export const updateEmployeeTool: McpTool = {
  name: 'update_employee',
  description:
    'Update a payroll employee. Only the fields you pass change; the rest are left alone. '
    + 'Setting end_date to today or a past date TERMINATES the employee; a future end_date '
    + 'schedules the departure and leaves them active until then. '
    + 'employee_number and start_date cannot be changed — create a new employee instead.',
  scope: 'write:payroll',
  requiresWriteRole: true,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      employee_id: { type: 'string' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      employment_type: { type: 'string', enum: [...SETTABLE_EMPLOYMENT_TYPES] },
      id_number: { type: 'string' },
      tax_number: { type: 'string' },
      date_of_birth: { type: 'string', format: 'date' },
      end_date: { type: 'string', format: 'date', description: 'Today or earlier terminates; later schedules' },
      uif_excluded: { type: 'boolean' },
      medical_aid_main_member: { type: 'boolean' },
      medical_aid_dependants_count: { type: 'number', minimum: 0 },
      s18a_receipt_held: { type: 'boolean', description: 'The employer holds the s18A receipt: donations (4030) may reduce PAYE and SDL' },
      idempotency_key: { type: 'string' },
    },
    required: ['employee_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const employeeId = strArg(args, 'employee_id');
    if (!employeeId) return toolError('employee_id is required');
    const bad = guardCastableArgs(args, {
      uuid: ['employee_id'],
      date: ['end_date', 'date_of_birth'],
    }) ?? refuseEmployeeTermArgs(args);
    if (bad) return bad;

    const employmentType = strArg(args, 'employment_type');
    if (employmentType !== undefined && !EMPLOYMENT_TYPES.includes(employmentType as EmploymentType)) {
      return toolError(`employment_type must be one of: ${EMPLOYMENT_TYPES.join(', ')}`);
    }
    const idNumber = strArg(args, 'id_number');
    if (idNumber !== undefined && !isValidSaIdNumber(idNumber)) {
      return toolError('id_number must be 13 digits');
    }
    const taxNumber = strArg(args, 'tax_number');
    if (taxNumber !== undefined && !isValidSarsTaxNumber(taxNumber)) {
      return toolError('tax_number must be a valid SARS tax reference (10 digits, starting 0, 1, 2, 3 or 9)');
    }

    // Answered from a READ before the write. `updatePayrollEmployee` returns
    // null for both "no such employee" and "another company's employee", and a
    // refusal is audited with a NULL idempotency key — so distinguishing them
    // here keeps the miss generic while still refusing before anything changes.
    if (!(await getPayrollEmployee(employeeId, ctx.companyId))) return toolError(NOT_FOUND);

    const endDate = strArg(args, 'end_date');
    const dateOfBirth = strArg(args, 'date_of_birth');

    if (args.s18a_receipt_held !== undefined && typeof args.s18a_receipt_held !== 'boolean') {
      return toolError('s18a_receipt_held must be true or false');
    }

    // The same check the create path makes. Without it a fractional count
    // reaches an INTEGER column, pg raises, and the agent gets the registry's
    // generic failure instead of the specific refusal create_employee gives.
    const dependants = args.medical_aid_dependants_count;
    if (dependants !== undefined && dependants !== null) {
      const n = Number(dependants);
      if (!Number.isInteger(n) || n < 0) {
        return toolError('medical_aid_dependants_count must be a whole number of 0 or more');
      }
    }

    const updated = await updatePayrollEmployee(employeeId, ctx.companyId, {
      ...(strArg(args, 'first_name') === undefined ? {} : { firstName: strArg(args, 'first_name') }),
      ...(strArg(args, 'last_name') === undefined ? {} : { lastName: strArg(args, 'last_name') }),
      ...(employmentType === undefined ? {} : { employmentType: employmentType as EmploymentType }),
      ...(idNumber === undefined ? {} : { idNumber }),
      ...(taxNumber === undefined ? {} : { taxNumber }),
      ...(endDate === undefined ? {} : { endDate: asDate(endDate) }),
      ...(dateOfBirth === undefined ? {} : { dateOfBirth: asDate(dateOfBirth) }),
      ...(args.uif_excluded === undefined ? {} : { uifExcluded: args.uif_excluded === true }),
      ...(args.medical_aid_main_member === undefined
        ? {} : { medicalAidMainMember: args.medical_aid_main_member === true }),
      ...(dependants === undefined || dependants === null
        ? {} : { medicalAidDependantsCount: Number(dependants) }),
      ...(args.s18a_receipt_held === undefined ? {} : { s18aReceiptHeld: args.s18a_receipt_held === true }),
    }, ctx.userId);

    if (!updated) return toolError(NOT_FOUND);
    return ok({
      id: updated.id,
      employee_number: updated.employeeNumber,
      first_name: updated.firstName,
      last_name: updated.lastName,
      employment_type: updated.employmentType,
      end_date: updated.endDate ? fmtDate(updated.endDate) : null,
    });
  },
};

export { assignEmployeeComponentTool, endEmployeeComponentTool } from './writeEmployeeComponents';
