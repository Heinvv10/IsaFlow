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
  recordEmployeeChange,
  listEmployeeHistory,
} from '@/modules/accounting/services/payroll/payrollEmployeeHistoryService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EMP_ID = 'e0000001-0000-0000-0000-000000000001';
const USER_ID = 'user-1';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('recordEmployeeChange', () => {
  it('inserts a row when old and new differ', async () => {
    mockImpl = () => Promise.resolve([]);
    await recordEmployeeChange({
      companyId: COMPANY_ID,
      employeeId: EMP_ID,
      fieldName: 'employment_type',
      oldValue: 'permanent',
      newValue: 'contract',
      userId: USER_ID,
    });
    const insert = sqlCalls.find(c => c.sql.includes('INSERT INTO payroll_employee_history'));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain('permanent');
    expect(insert!.values).toContain('contract');
  });

  it('skips insert when old equals new', async () => {
    await recordEmployeeChange({
      companyId: COMPANY_ID,
      employeeId: EMP_ID,
      fieldName: 'department',
      oldValue: 'FIN',
      newValue: 'FIN',
      userId: USER_ID,
    });
    expect(sqlCalls.some(c => c.sql.includes('INSERT'))).toBe(false);
  });

  it('records a transition from null to a value', async () => {
    await recordEmployeeChange({
      companyId: COMPANY_ID,
      employeeId: EMP_ID,
      fieldName: 'cost_centre_id',
      oldValue: null,
      newValue: 'cc-1',
      userId: USER_ID,
    });
    const insert = sqlCalls.find(c => c.sql.includes('INSERT INTO payroll_employee_history'));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain(null);
    expect(insert!.values).toContain('cc-1');
  });

  it('skips when both are null', async () => {
    await recordEmployeeChange({
      companyId: COMPANY_ID,
      employeeId: EMP_ID,
      fieldName: 'cost_centre_id',
      oldValue: null,
      newValue: null,
      userId: USER_ID,
    });
    expect(sqlCalls).toHaveLength(0);
  });

  it('passes effectiveFrom and changeReason when provided', async () => {
    await recordEmployeeChange({
      companyId: COMPANY_ID,
      employeeId: EMP_ID,
      fieldName: 'department',
      oldValue: 'FIN',
      newValue: 'OPS',
      userId: USER_ID,
      effectiveFrom: '2026-04-01',
      changeReason: 'Department restructure',
    });
    const insert = sqlCalls.find(c => c.sql.includes('INSERT INTO payroll_employee_history'));
    expect(insert!.values).toContain('2026-04-01');
    expect(insert!.values).toContain('Department restructure');
  });
});

describe('listEmployeeHistory', () => {
  it('returns rows mapped with dates, scoped by company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employee_history')) {
        return Promise.resolve([
          {
            id: 'h1',
            field_name: 'employment_type',
            old_value: 'permanent',
            new_value: 'contract',
            effective_from: '2026-04-01',
            change_reason: null,
            changed_by: USER_ID,
            changed_by_name: 'Jane Doe',
            created_at: new Date('2026-04-02T10:00:00Z'),
          },
        ]);
      }
      return Promise.resolve([]);
    };
    const rows = await listEmployeeHistory(COMPANY_ID, EMP_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fieldName).toBe('employment_type');
    expect(rows[0]!.oldValue).toBe('permanent');
    expect(rows[0]!.newValue).toBe('contract');
    expect(rows[0]!.changedByName).toBe('Jane Doe');
    const call = sqlCalls.find(c => c.sql.includes('FROM payroll_employee_history'));
    expect(call!.values).toContain(COMPANY_ID);
    expect(call!.values).toContain(EMP_ID);
  });
});
