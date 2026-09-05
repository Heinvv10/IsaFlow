import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[]; viaTx?: boolean }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  // withTransaction replaces the raw BEGIN/COMMIT the services used to emit.
  //
  // The `tx` handed to the callback records with `viaTx: true` so a statement
  // issued INSIDE the transaction is distinguishable from one issued bare
  // through `sql`. Without that marker the two are identical in this log, and a
  // regression that dropped withTransaction entirely — leaving a mid-loop
  // failure to strand a DELETE with no INSERTs — would pass every test here.
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ sql: strings.join('?'), values, viaTx: true });
      return mockImpl(strings, ...values);
    },
  ),
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

  it('writes the updates and a history row per tracked field change, in one unit of work', async () => {
    happy();
    const result = await applyBulkEmployeeUpdate(
      COMPANY_ID,
      { department: 'OPS-OLD' },
      { department: 'OPS', costCentreId: CC_X },
      USER_ID,
      { effectiveFrom: '2026-05-01', changeReason: 'Dept merge' },
    );

    expect(result.updated).toBe(1);
    // No BEGIN/COMMIT: the service no longer emits them. `sql` routes onto the
    // request's ALS client, so a raw COMMIT committed the WHOLE request;
    // withTransaction nests a SAVEPOINT, which is not a statement in this log.
    expect(sqlCalls.some(c => c.sql.trim() === 'BEGIN')).toBe(false);
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_employees'))).toBe(true);
    const hist = sqlCalls.filter(c => c.sql.includes('INSERT INTO payroll_employee_history'));
    expect(hist.length).toBe(2);
    expect(sqlCalls.some(c => c.sql.trim() === 'COMMIT')).toBe(false);
    // The UPDATEs went through the TRANSACTION, not bare `sql` — otherwise the
    // suite cannot distinguish withTransaction from no transaction at all.
    const updates = sqlCalls.filter(c => c.sql.includes('UPDATE payroll_employees'));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(c => c.viaTx === true)).toBe(true);
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

  it('propagates an update failure so the surrounding transaction unwinds', async () => {
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
    // Rollback is withTransaction's savepoint, not a statement this service
    // emits. What the service owes its caller is that the error PROPAGATES.
    expect(sqlCalls.some(c => c.sql.trim() === 'ROLLBACK')).toBe(false);
  });

  it('returns 0 and writes nothing when nothing matches', async () => {
    mockImpl = () => Promise.resolve([]);
    const result = await applyBulkEmployeeUpdate(
      COMPANY_ID,
      { department: 'NOPE' },
      { department: 'OPS' },
      USER_ID,
    );
    expect(result.updated).toBe(0);
    // Asserts the OUTCOME, not the early return. Two things this does not prove,
    // stated so nobody reads more into it: the service emits no BEGIN on any
    // path now, so the old `BEGIN === false` check could not fail; and deleting
    // the `rows.length === 0` early return does not turn this red either, since
    // an empty loop writes nothing regardless. What it does catch is a
    // regression that writes on a no-match.
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_employees'))).toBe(false);
    expect(sqlCalls.some(c => c.sql.includes('INSERT INTO'))).toBe(false);
  });
});
