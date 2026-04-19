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

describe('assignComponentToEmployee', () => {
  it('inserts and returns the mapped row when employee is in company', async () => {
    const employeeRow = { id: EMPLOYEE_ID };
    const insertedRow = {
      id: ASSIGNMENT_ID,
      employee_id: EMPLOYEE_ID,
      component_id: COMPONENT_ID,
      amount: '5000.00',
      effective_from: new Date('2025-01-01'),
      effective_to: null,
    };

    mockImpl = (strings) => {
      const query = strings.join('?');
      if (query.includes('FROM payroll_employees')) {
        return Promise.resolve([employeeRow]);
      }
      if (query.includes('INSERT INTO payroll_employee_components')) {
        return Promise.resolve([insertedRow]);
      }
      return Promise.resolve([]);
    };

    const result = await assignComponentToEmployee(
      COMPANY_ID,
      EMPLOYEE_ID,
      COMPONENT_ID,
      5000,
      new Date('2025-01-01'),
    );

    expect(result).toEqual({
      id: ASSIGNMENT_ID,
      employeeId: EMPLOYEE_ID,
      componentId: COMPONENT_ID,
      amount: 5000,
      effectiveFrom: new Date('2025-01-01'),
      effectiveTo: null,
    });

    // Verify employee lookup was done
    const lookupCall = sqlCalls.find(c => c.sql.includes('FROM payroll_employees'));
    expect(lookupCall).toBeDefined();

    // Verify insert was done
    const insertCall = sqlCalls.find(c => c.sql.includes('INSERT INTO payroll_employee_components'));
    expect(insertCall).toBeDefined();
  });

  it('throws when the employee lookup returns empty', async () => {
    mockImpl = (strings) => {
      const query = strings.join('?');
      if (query.includes('FROM payroll_employees')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    };

    await expect(
      assignComponentToEmployee(
        COMPANY_ID,
        EMPLOYEE_ID,
        COMPONENT_ID,
        5000,
        new Date('2025-01-01'),
      ),
    ).rejects.toThrow(`Payroll employee ${EMPLOYEE_ID} not found in company`);
  });
});

describe('endEmployeeComponent', () => {
  it('issues UPDATE with the effective_to date and company-scope subquery', async () => {
    mockImpl = () => Promise.resolve([]);

    await endEmployeeComponent(COMPANY_ID, ASSIGNMENT_ID, new Date('2025-12-31'));

    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0];
    expect(call).toBeDefined();
    expect(call!.sql).toContain('UPDATE payroll_employee_components');
    expect(call!.sql).toContain('effective_to');
    expect(call!.sql).toContain('SELECT id FROM payroll_employees');
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
