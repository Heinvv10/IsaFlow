/**
 * MCP write tools: an employee's pay components (assign, end). Moved out of writeEmployees.ts, unchanged, for the 300-line cap.
 */
import type { McpTool } from '../types';
import { getPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import {
  assignComponentToEmployee,
  endEmployeeComponent,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { EmployeeComponentRefused } from '@/modules/accounting/services/payroll/payrollEmployeeComponentRefused';
import { listComponents } from '@/modules/accounting/services/payroll/payrollComponentService';
import { NOT_FOUND, guardCastableArgs, hasWholeCents, ok, strArg, toolError } from './toolHelpers';

export const assignEmployeeComponentTool: McpTool = {
  name: 'assign_employee_component',
  description:
    'Give an employee a pay component — a basic salary, an allowance, a deduction. '
    + 'This is what makes an employee payable: the run costs earnings from components, so an '
    + 'employee with none costs to R0. Resolve component_id with list_payroll_components first. '
    + 'A RECURRING assignment runs every month from effective_from until it is ended; a once-off '
    + '(is_recurring: false) dies at the end of the month it was captured for. '
    + 'Amounts are to the cent and post NOTHING to the ledger. A pension, provident or RA contribution (deduction 4001/4003/4006, '
    + 'or the employer\'s earning 3817/3825/3828) may instead be percent_of_rfi, a fraction of retirement-funding income '
    + '(0.075 = 7.5%) with amount 0: each run costs it on the earnings flagged counts_as_rfi.',
  scope: 'write:payroll',
  requiresWriteRole: true,
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
      percent_of_rfi: { type: 'number', description: 'Fraction of retirement-funding income, 0 < p <= 1, four decimals; amount must be 0' },
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
    // employee and the component itself and throws, but a throw after the registry's savepoint
    // opened is a worse answer than a refusal before it.
    if (!(await getPayrollEmployee(employeeId, ctx.companyId))) return toolError(NOT_FOUND);
    const components = await listComponents(ctx.companyId);
    const component = components.find((c) => c.id === componentId);
    if (!component) return toolError(NOT_FOUND);

    const effectiveTo = strArg(args, 'effective_to');
    let assignment: Awaited<ReturnType<typeof assignComponentToEmployee>>;
    try {
      assignment = await assignComponentToEmployee(
        ctx.companyId,
        employeeId,
        componentId,
        amount,
        effectiveFrom,
        effectiveTo,
        args.is_recurring !== false,
        { userId: ctx.userId, channel: 'mcp' },
        // Judged by the service before the write (type, range, amount 0, a retirement contribution).
        args.percent_of_rfi === undefined || args.percent_of_rfi === null ? null : (args.percent_of_rfi as number),
      );
    } catch (err) {
      if (err instanceof EmployeeComponentRefused) return toolError(err.message);
      throw err;
    }

    return ok({
      id: assignment.id,
      employee_id: employeeId,
      component_id: componentId,
      component_name: component.name,
      component_type: component.componentType,
      amount,
      percent_of_rfi: assignment.percentOfRfi,
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
    + 'An end only shortens. An assignment no approved run has paid is cancelled (voided, never paid) when it is a '
    + 'once-off, when effective_to is before its start, or with cancel: true. '
    + 'Resolve assignment_id with list_employee_components.',
  scope: 'write:payroll',
  requiresWriteRole: true,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      assignment_id: { type: 'string', description: 'From list_employee_components' },
      effective_to: { type: 'string', format: 'date', description: 'Last date the component applies' },
      cancel: {
        type: 'boolean',
        description: 'Cancel (void) an assignment no approved run has paid, instead of ending it: it is then never paid. '
          + 'Refused once a paid run read it. A once-off no run has paid is always cancelled by an end.',
      },
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
    let ended: boolean;
    try {
      ended = await endEmployeeComponent(ctx.companyId, assignmentId, effectiveTo, { userId: ctx.userId, channel: 'mcp' }, {
        cancel: args.cancel === true,
      });
    } catch (err) {
      // End's guards (payrollComponentDateEdit): a refusal is the agent's to read; anything else is not.
      if (err instanceof EmployeeComponentRefused) return toolError(err.message);
      throw err;
    }
    if (!ended) return toolError(NOT_FOUND);
    return ok({ assignment_id: assignmentId, effective_to: effectiveTo, ended: true });
  },
};
