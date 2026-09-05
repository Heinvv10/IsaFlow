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
import {
  assignComponentToEmployee,
  endEmployeeComponent,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { listComponents } from '@/modules/accounting/services/payroll/payrollComponentService';
import type { EmploymentType } from '@/modules/accounting/services/payroll/payrollTypes';
import {
  isValidSaIdNumber,
  isValidSarsTaxNumber,
} from '@/modules/accounting/services/payroll/irp5ValidationEngine';
import {
  NOT_FOUND,
  guardCastableArgs,
  hasWholeCents,
  ok,
  safeErrorText,
  strArg,
  toolError,
} from './toolHelpers';

const EMPLOYMENT_TYPES: readonly EmploymentType[] = ['permanent', 'contract', 'casual', 'director'];

/*
 * The repo's OWN rules, not a local approximation. `isValidSarsTaxNumber` is
 * `/^[01239]\d{9}$/` — ten digits with a constrained leading digit — and a
 * plain `/^\d{10}$/` here accepted `4123456789`, which `irp5ValidationEngine`
 * then rejects at IRP5 time. That is exactly the "rejected months later by
 * someone who cannot tell which employee it came from" this check exists to
 * prevent, so the check has to be the same one.
 */

/**
 * `YYYY-MM-DD` from the agent, as a Date the services take.
 *
 * LOCAL midnight, not UTC. The services render these back through `fmtDate`,
 * which uses local calendar getters on purpose — `toISOString()` there reported
 * the PREVIOUS day on the UTC+2 host and shifted journal dates across VAT
 * period boundaries (see `src/lib/pgTypes.ts`). A Date built at UTC midnight
 * survives that on a UTC or UTC-plus host and silently loses a day on a
 * UTC-minus one, so it is built where it is read instead.
 */
export function asDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

export const createEmployeeTool: McpTool = {
  name: 'create_employee',
  description:
    'Create a payroll employee. Posts NOTHING to the ledger — this is subledger setup. '
    + 'An employee created here is paid NOTHING until assign_employee_component gives them a salary: '
    + 'the run costs earnings from components, not from the employee record, so a run over '
    + 'component-less employees costs cleanly to R0 rather than failing. '
    + 'employment_type drives the PAYE and UIF treatment, so it must be right: '
    + 'permanent, contract, casual or director.',
  scope: 'write:payroll',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      employee_number: { type: 'string', description: "The company's own employee number" },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      employment_type: { type: 'string', enum: [...EMPLOYMENT_TYPES] },
      start_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      id_number: { type: 'string', description: 'SA ID number, 13 digits' },
      tax_number: { type: 'string', description: 'SARS tax reference, 10 digits' },
      date_of_birth: { type: 'string', format: 'date' },
      end_date: { type: 'string', format: 'date', description: 'Only for someone who has already left' },
      uif_excluded: { type: 'boolean', description: 'Default false. True only where UIF genuinely does not apply.' },
      medical_aid_main_member: { type: 'boolean' },
      medical_aid_dependants_count: { type: 'number', minimum: 0 },
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
    });
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
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      employee_id: { type: 'string' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      employment_type: { type: 'string', enum: [...EMPLOYMENT_TYPES] },
      id_number: { type: 'string' },
      tax_number: { type: 'string' },
      date_of_birth: { type: 'string', format: 'date' },
      end_date: { type: 'string', format: 'date', description: 'Today or earlier terminates; later schedules' },
      uif_excluded: { type: 'boolean' },
      medical_aid_main_member: { type: 'boolean' },
      medical_aid_dependants_count: { type: 'number', minimum: 0 },
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
    });
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

export const assignEmployeeComponentTool: McpTool = {
  name: 'assign_employee_component',
  description:
    'Give an employee a pay component — a basic salary, an allowance, a deduction. '
    + 'This is what makes an employee payable: the run costs earnings from components, so an '
    + 'employee with none costs to R0. Resolve component_id with list_payroll_components first. '
    + 'A RECURRING assignment runs every month from effective_from until it is ended; a once-off '
    + '(is_recurring: false) dies at the end of the month it was captured for. '
    + 'Amounts are to the cent and post NOTHING to the ledger.',
  scope: 'write:payroll',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      employee_id: { type: 'string' },
      component_id: { type: 'string', description: 'From list_payroll_components' },
      amount: { type: 'number', description: 'Monthly amount, to the cent' },
      effective_from: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      effective_to: { type: 'string', format: 'date' },
      is_recurring: { type: 'boolean', description: 'Default true' },
      idempotency_key: { type: 'string' },
    },
    required: ['employee_id', 'component_id', 'amount', 'effective_from', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const employeeId = strArg(args, 'employee_id');
    const componentId = strArg(args, 'component_id');
    const effectiveFrom = strArg(args, 'effective_from');
    if (!employeeId) return toolError('employee_id is required');
    if (!componentId) return toolError('component_id is required');
    if (!effectiveFrom) return toolError('effective_from is required (YYYY-MM-DD)');

    const bad = guardCastableArgs(args, {
      uuid: ['employee_id', 'component_id'],
      date: ['effective_from', 'effective_to'],
    });
    if (bad) return bad;

    const amount = Number(args.amount);
    if (!Number.isFinite(amount)) return toolError('amount must be a number');
    if (!hasWholeCents(amount)) {
      return toolError(`amount has more than two decimal places (${amount}) — amounts are stored to the cent.`);
    }

    // Ownership before the write. `assignComponentToEmployee` checks the
    // employee itself and throws, but a throw after the registry's savepoint
    // opened is a worse answer than a refusal before it.
    if (!(await getPayrollEmployee(employeeId, ctx.companyId))) return toolError(NOT_FOUND);
    const components = await listComponents(ctx.companyId);
    const component = components.find((c) => c.id === componentId);
    if (!component) return toolError(NOT_FOUND);

    const effectiveTo = strArg(args, 'effective_to');
    const assignment = await assignComponentToEmployee(
      ctx.companyId,
      employeeId,
      componentId,
      amount,
      asDate(effectiveFrom),
      effectiveTo === undefined ? undefined : asDate(effectiveTo),
      args.is_recurring !== false,
    );

    return ok({
      id: assignment.id,
      employee_id: employeeId,
      component_id: componentId,
      component_name: component.name,
      component_type: component.componentType,
      amount,
      effective_from: effectiveFrom,
      is_recurring: args.is_recurring !== false,
    });
  },
};

export const endEmployeeComponentTool: McpTool = {
  name: 'end_employee_component',
  description:
    'Stop a pay component from a given date — a salary that changed, an allowance that ended. '
    + 'The assignment is CLOSED, never deleted, so past runs that costed it stay explainable. '
    + 'To change a salary: end the old assignment and assign a new one from the following month. '
    + 'Resolve assignment_id with list_employee_components.',
  scope: 'write:payroll',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      assignment_id: { type: 'string', description: 'From list_employee_components' },
      effective_to: { type: 'string', format: 'date', description: 'Last date the component applies' },
      idempotency_key: { type: 'string' },
    },
    required: ['assignment_id', 'effective_to', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const assignmentId = strArg(args, 'assignment_id');
    const effectiveTo = strArg(args, 'effective_to');
    if (!assignmentId) return toolError('assignment_id is required');
    if (!effectiveTo) return toolError('effective_to is required (YYYY-MM-DD)');
    const bad = guardCastableArgs(args, { uuid: ['assignment_id'], date: ['effective_to'] });
    if (bad) return bad;

    // The service reports whether a row was ACTUALLY closed. It scopes its
    // UPDATE through the employee's company, so a stale or foreign assignment
    // matches nothing and the statement succeeds having changed nothing —
    // answering `ended: true` there would tell an agent an old salary was
    // stopped while it stayed live, and the next costed run would pay it.
    const ended = await endEmployeeComponent(ctx.companyId, assignmentId, asDate(effectiveTo));
    if (!ended) return toolError(NOT_FOUND);
    return ok({ assignment_id: assignmentId, effective_to: effectiveTo, ended: true });
  },
};
