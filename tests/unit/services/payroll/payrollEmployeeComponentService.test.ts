import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => {
  const SQL = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  };
  return {
  sql: SQL,
  // assign and batch post now run in a transaction under the company's payroll-approval lock: the lock's two
  // statements are answered here and not recorded, everything else goes to the recorder above.
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('pg_advisory_xact_lock') || text.includes("set_config('lock_timeout'")) return Promise.resolve([{ previous: '0' }]);
    return SQL(strings, ...values);
  }),
  };
});

vi.mock('@/modules/accounting/services/payroll/payrollAssignmentWriteGuard', () => ({ refuseAssignmentWrite: vi.fn(async () => undefined) })); // covered by the integration suites
import {
  assignComponentToEmployee,
  EmployeeComponentRefused,
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
const ACTOR = { userId: 'u-1', channel: 'service' as const };

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
      if (query.includes('FROM payroll_components')) {
        return Promise.resolve([{ id: COMPONENT_ID }]);
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
      '2025-01-01',
      undefined,
      true,
      ACTOR,
    );

    expect(result).toEqual({
      id: ASSIGNMENT_ID,
      employeeId: EMPLOYEE_ID,
      componentId: COMPONENT_ID,
      amount: 5000,
      effectiveFrom: new Date('2025-01-01'),
      effectiveTo: null,
      isRecurring: true,
    });

    // Verify employee lookup was done
    const lookupCall = sqlCalls.find(c => c.sql.includes('FROM payroll_employees'));
    expect(lookupCall).toBeDefined();

    // Verify insert was done
    const insertCall = sqlCalls.find(c => c.sql.includes('INSERT INTO payroll_employee_components'));
    expect(insertCall).toBeDefined();
  });

  it('closes a once-off assignment on the true last day of the month, in any timezone', async () => {
    // The month-end was previously derived with local-time accessors and then
    // rendered with toISOString(), so east of UTC (SAST) it landed a day early
    // and the assignment died before the month it was captured for ended.
    mockImpl = (strings) => {
      const query = strings.join('?');
      if (query.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMPLOYEE_ID }]);
      return Promise.resolve([{
        id: ASSIGNMENT_ID, employee_id: EMPLOYEE_ID, component_id: COMPONENT_ID,
        amount: '5000.00', effective_from: new Date('2025-03-01'),
        effective_to: new Date('2025-03-31'), is_recurring: false,
      }]);
    };

    await assignComponentToEmployee(
      COMPANY_ID, EMPLOYEE_ID, COMPONENT_ID, 5000, '2025-03-01', undefined, false, ACTOR,
    );

    const insertCall = sqlCalls.find(c => c.sql.includes('INSERT INTO payroll_employee_components'));
    expect(insertCall!.values).toContain('2025-03-31');
    expect(insertCall!.values).not.toContain('2025-03-30');
  });

  it('leaves a recurring assignment open-ended', async () => {
    mockImpl = (strings) => {
      const query = strings.join('?');
      if (query.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMPLOYEE_ID }]);
      return Promise.resolve([{
        id: ASSIGNMENT_ID, employee_id: EMPLOYEE_ID, component_id: COMPONENT_ID,
        amount: '5000.00', effective_from: new Date('2025-03-01'),
        effective_to: null, is_recurring: true,
      }]);
    };

    await assignComponentToEmployee(
      COMPANY_ID, EMPLOYEE_ID, COMPONENT_ID, 5000, '2025-03-01', undefined, true, ACTOR,
    );

    const insertCall = sqlCalls.find(c => c.sql.includes('INSERT INTO payroll_employee_components'));
    expect(insertCall!.values).toContain(null);
  });

  it("refuses another company's component before the insert, reading it by this company", async () => {
    mockImpl = (strings) => Promise.resolve(strings.join('?').includes('FROM payroll_employees') ? [{ id: EMPLOYEE_ID }] : []);
    await expect(
      assignComponentToEmployee(COMPANY_ID, EMPLOYEE_ID, COMPONENT_ID, 5000, '2025-01-01', undefined, true, ACTOR),
    ).rejects.toBeInstanceOf(EmployeeComponentRefused);
    expect(sqlCalls.find(c => c.sql.includes('INSERT'))).toBeUndefined();
    const lookup = sqlCalls.find(c => c.sql.includes('FROM payroll_components'));
    expect(lookup!.sql).toContain('company_id = ?::uuid');
    expect(lookup!.values).toEqual([COMPONENT_ID, COMPANY_ID]);
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
        '2025-01-01',
      ),
    ).rejects.toThrow(`Payroll employee ${EMPLOYEE_ID} not found in company`);
  });
});

describe('day strings', () => {
  it('refuses a date that is not a real YYYY-MM-DD before any write', async () => {
    mockImpl = (strings) => Promise.resolve(strings.join('?').includes('FROM') ? [{ id: 'x' }] : []);
    for (const bad of ['2025-02-30', '2025-3-1', 'tomorrow', '2025-03-01T00:00:00Z']) {
      await expect(assignComponentToEmployee(COMPANY_ID, EMPLOYEE_ID, COMPONENT_ID, 1, bad, undefined, true, ACTOR))
        .rejects.toBeInstanceOf(EmployeeComponentRefused);
    }
    await expect(endEmployeeComponent(COMPANY_ID, ASSIGNMENT_ID, '2025-02-30'))
      .rejects.toBeInstanceOf(EmployeeComponentRefused);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT') || c.sql.includes('UPDATE'))).toBe(false);
  });
});

describe('endEmployeeComponent', () => {
  // What End does to a row (cancel an unpaid once-off, end the rest, refuse foreign ids) runs against a real
  // database: tests/integration/payroll-component-edit-dates-guards.int.test.ts, payroll-run-once-off-window.int.test.ts.
  it('an id that is not a uuid changes nothing and touches no table', async () => {
    expect(await endEmployeeComponent(COMPANY_ID, 'not-a-uuid', '2025-12-31', { userId: 'u-1', channel: 'service' })).toBe(false);
    expect(sqlCalls).toHaveLength(0);
  });
});

const listCallSql = () => sqlCalls.find(c => c.sql.includes('JOIN payroll_components'))?.sql ?? '';

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
      component_active: true,
      is_taxable: false,
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
      componentActive: true,
      isTaxable: false,
    });
    expect(listCallSql()).toContain('pc.is_taxable');

    // Verify the list query uses a JOIN
    const listCall = sqlCalls.find(c => c.sql.includes('JOIN payroll_components'));
    expect(listCall).toBeDefined();
  });
});
