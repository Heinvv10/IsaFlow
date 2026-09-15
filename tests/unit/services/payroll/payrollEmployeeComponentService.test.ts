import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

interface CompensationAssign { actions: Array<{ effectiveTo: string | null; isRecurring: boolean }> }
/**
 * Null by default, so the admission tests below run the REAL adapter and prove the writer refuses
 * outside an issued control transaction. Set by a test that needs to see the plan the service built
 * before the kernel takes over — the once-off window is still computed here, not in the kernel.
 */
let callerOverride: ((input: unknown) => Promise<{ assignmentIds: string[]; inserted: number; ended: number }>) | null = null;
vi.mock('@/modules/accounting/services/controls/payrollCompensationLegacyAdapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/controls/payrollCompensationLegacyAdapter')>();
  return {
    ...actual,
    executeCompensationCaller: (
      companyId: string, input: unknown,
      options?: { intentId?: string; approvalId?: string }, userId?: string,
    ) => callerOverride ? callerOverride(input) : actual.executeCompensationCaller(companyId, input, options, userId),
  };
});

import {
  assignComponentToEmployee,
  endEmployeeComponent,
  listEmployeeComponentAssignments,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
  callerOverride = null;
});

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const COMPONENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ASSIGNMENT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// Real approval, source mutation, replay and protected events are exercised in
// tests/integration/controls/payrollCompensationControl.int.test.ts.
describe('compensation writer admission',()=>{
 it('refuses assignment without an issued transaction before SQL',async()=>{
  await expect(assignComponentToEmployee(COMPANY_ID,EMPLOYEE_ID,COMPONENT_ID,5000,new Date('2025-01-01'))).rejects.toThrow(/context|transaction/i);
  expect(sqlCalls).toHaveLength(0);
 });
 it('refuses closure without an issued transaction before SQL',async()=>{
  await expect(endEmployeeComponent(COMPANY_ID,ASSIGNMENT_ID,new Date('2025-01-31'))).rejects.toThrow(/context|transaction/i);
  expect(sqlCalls).toHaveLength(0);
 });
});

describe('the assignment window the writer hands the kernel', () => {
  const assignedRow = {
    id: ASSIGNMENT_ID, employee_id: EMPLOYEE_ID, component_id: COMPONENT_ID,
    amount: '5000.00', effective_from: new Date('2025-03-01'),
    effective_to: new Date('2025-03-31'), is_recurring: false,
  };

  /** The plan the service built, captured before the kernel would have taken it. */
  async function planFor(isRecurring: boolean): Promise<CompensationAssign> {
    let seen: unknown;
    callerOverride = async (input) => {
      seen = input;
      return { assignmentIds: [ASSIGNMENT_ID], inserted: 1, ended: 0 };
    };
    mockImpl = () => Promise.resolve([assignedRow]);
    await assignComponentToEmployee(
      COMPANY_ID, EMPLOYEE_ID, COMPONENT_ID, 5000, new Date('2025-03-01'), undefined, isRecurring,
    );
    return seen as CompensationAssign;
  }

  it('closes a once-off assignment on the true last day of the month, in any timezone', async () => {
    // The month-end was previously derived with local-time accessors and then rendered with
    // toISOString(), so east of UTC (SAST) it landed a day early and the assignment died before
    // the month it was captured for ended. endOfMonthIso is the one shared helper now.
    const plan = await planFor(false);
    expect(plan.actions[0]!.effectiveTo).toBe('2025-03-31');
    expect(plan.actions[0]!.effectiveTo).not.toBe('2025-03-30');
  });

  it('leaves a recurring assignment open-ended', async () => {
    expect((await planFor(true)).actions[0]!.effectiveTo).toBeNull();
  });

  it('returns the assignment read back from the row the kernel wrote', async () => {
    callerOverride = async () => ({ assignmentIds: [ASSIGNMENT_ID], inserted: 1, ended: 0 });
    mockImpl = () => Promise.resolve([assignedRow]);
    const result = await assignComponentToEmployee(
      COMPANY_ID, EMPLOYEE_ID, COMPONENT_ID, 5000, new Date('2025-03-01'), undefined, false,
    );
    expect(result).toEqual({
      id: ASSIGNMENT_ID, employeeId: EMPLOYEE_ID, componentId: COMPONENT_ID, amount: 5000,
      effectiveFrom: new Date('2025-03-01'), effectiveTo: new Date('2025-03-31'), isRecurring: false,
    });
    // Read back through the employee join, so a row belonging to another tenant is not returned.
    expect(sqlCalls[0]!.sql).toContain('JOIN payroll_employees');
    expect(sqlCalls[0]!.values).toContain(COMPANY_ID);
  });
});

describe('listEmployeeComponentAssignments', () => {
  it('joins payroll_components and returns componentName/componentType alongside the assignment', async () => {
    const employeeRow = { id: EMPLOYEE_ID };
    const assignmentRow = {
      id: ASSIGNMENT_ID,
      employee_id: EMPLOYEE_ID,
      component_id: COMPONENT_ID,
      amount: '8000.00',
      effective_from: new Date('2025-01-01'),
      effective_to: null,
      component_name: 'Basic Salary',
      component_type: 'earning',
    };

    mockImpl = (strings) => {
      const query = strings.join('?');
      if (query.includes('FROM payroll_employees') && !query.includes('JOIN')) {
        return Promise.resolve([employeeRow]);
      }
      if (query.includes('JOIN payroll_components')) {
        return Promise.resolve([assignmentRow]);
      }
      return Promise.resolve([]);
    };

    const results = await listEmployeeComponentAssignments(COMPANY_ID, EMPLOYEE_ID);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: ASSIGNMENT_ID,
      employeeId: EMPLOYEE_ID,
      componentId: COMPONENT_ID,
      amount: 8000,
      componentName: 'Basic Salary',
      componentType: 'earning',
    });

    // Verify the list query uses a JOIN
    const listCall = sqlCalls.find(c => c.sql.includes('JOIN payroll_components'));
    expect(listCall).toBeDefined();
  });
});
