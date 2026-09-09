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

import {
  assignComponentToEmployee,
  endEmployeeComponent,
  listEmployeeComponentAssignments,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
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
