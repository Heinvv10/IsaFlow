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
  previewBulkEmployeeUpdate,
  applyBulkEmployeeUpdate,
  EmptyUpdateError,
  EmptyFilterError,
} from '@/modules/accounting/services/payroll/payrollBulkEmployeeService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = 'user-1';
const EMP_A = 'e0000001-0000-0000-0000-000000000001';
const EMP_B = 'e0000001-0000-0000-0000-000000000002';
const CC_X = 'cc000001-0000-0000-0000-00000000000a';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('previewBulkEmployeeUpdate', () => {
  it('returns matching employees with old + new values', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) {
        return Promise.resolve([
          {
            id: EMP_A,
            employee_number: 'E001',
            first_name: 'Jane',
            last_name: 'Doe',
            department: 'OPS-OLD',
            cost_centre_id: null,
            employment_type: 'permanent',
          },
          {
            id: EMP_B,
            employee_number: 'E002',
            first_name: 'John',
            last_name: 'Smith',
            department: 'OPS-OLD',
            cost_centre_id: null,
            employment_type: 'permanent',
          },
        ]);
      }
      return Promise.resolve([]);
    };

    const preview = await previewBulkEmployeeUpdate(
      COMPANY_ID,
      { department: 'OPS-OLD' },
      { department: 'OPS' },
    );

    expect(preview.matchCount).toBe(2);
    expect(preview.sample).toHaveLength(2);
    expect(preview.sample[0]!.employeeNumber).toBe('E001');
    expect(preview.sample[0]!.changes.department).toEqual({ from: 'OPS-OLD', to: 'OPS' });
  });

  it('rejects empty update', async () => {
    await expect(
      previewBulkEmployeeUpdate(COMPANY_ID, { department: 'X' }, {}),
    ).rejects.toBeInstanceOf(EmptyUpdateError);
  });

  it('rejects empty filter', async () => {
    await expect(
      previewBulkEmployeeUpdate(COMPANY_ID, {}, { department: 'OPS' }),
    ).rejects.toBeInstanceOf(EmptyFilterError);
  });
});

describe('applyBulkEmployeeUpdate', () => {
  function happy(): void {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) {
        return Promise.resolve([
          {
            id: EMP_A,
            employee_number: 'E001',
            first_name: 'Jane',
            last_name: 'Doe',
            department: 'OPS-OLD',
            cost_centre_id: null,
            employment_type: 'permanent',
          },
        ]);
      }
      return Promise.resolve([]);
    };
  }

  it('wraps changes in BEGIN/COMMIT and writes a history row per tracked field change', async () => {
    happy();
    const result = await applyBulkEmployeeUpdate(
      COMPANY_ID,
      { department: 'OPS-OLD' },
      { department: 'OPS', costCentreId: CC_X },
      USER_ID,
      { effectiveFrom: '2026-05-01', changeReason: 'Dept merge' },
    );

    expect(result.updated).toBe(1);
    expect(sqlCalls.some(c => c.sql.trim() === 'BEGIN')).toBe(true);
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_employees'))).toBe(true);
    const hist = sqlCalls.filter(c => c.sql.includes('INSERT INTO payroll_employee_history'));
    expect(hist.length).toBe(2);
    expect(sqlCalls.some(c => c.sql.trim() === 'COMMIT')).toBe(true);
  });

  it('does not insert history for a field that was already equal to the new value', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) {
        return Promise.resolve([
          {
            id: EMP_A,
            employee_number: 'E001',
            first_name: 'Jane',
            last_name: 'Doe',
            department: 'OPS',
            cost_centre_id: null,
            employment_type: 'permanent',
          },
        ]);
      }
      return Promise.resolve([]);
    };
    await applyBulkEmployeeUpdate(
      COMPANY_ID,
      { department: 'OPS' },
      { department: 'OPS' },
      USER_ID,
    );
    const hist = sqlCalls.filter(c => c.sql.includes('INSERT INTO payroll_employee_history'));
    expect(hist.length).toBe(0);
  });

  it('rolls back on update failure', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) {
        return Promise.resolve([{
          id: EMP_A, employee_number: 'E001', first_name: 'Jane', last_name: 'Doe',
          department: 'OPS-OLD', cost_centre_id: null, employment_type: 'permanent',
        }]);
      }
      if (q.includes('UPDATE payroll_employees')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve([]);
    };
    await expect(
      applyBulkEmployeeUpdate(COMPANY_ID, { department: 'OPS-OLD' }, { department: 'OPS' }, USER_ID),
    ).rejects.toThrow(/boom/);
    expect(sqlCalls.some(c => c.sql.trim() === 'ROLLBACK')).toBe(true);
  });

  it('returns 0 when nothing matches (no transaction opened)', async () => {
    mockImpl = () => Promise.resolve([]);
    const result = await applyBulkEmployeeUpdate(
      COMPANY_ID,
      { department: 'NOPE' },
      { department: 'OPS' },
      USER_ID,
    );
    expect(result.updated).toBe(0);
    expect(sqlCalls.some(c => c.sql.trim() === 'BEGIN')).toBe(false);
  });
});
