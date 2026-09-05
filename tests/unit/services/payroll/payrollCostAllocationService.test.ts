import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  // withTransaction is what the services now use instead of raw BEGIN/COMMIT.
  // The `tx` handed to the callback records into the SAME sqlCalls log, so the
  // statement assertions below are unchanged; what is gone is the BEGIN/COMMIT
  // pair, which never belonged to the service in the first place — `sql` routes
  // onto the request's ALS client, so that COMMIT committed the whole request.
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ sql: strings.join('?'), values });
      return mockImpl(strings, ...values);
    },
  ),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import {
  setEmployeeCostAllocations,
  getEmployeeCostAllocations,
  splitRunLineAcrossAllocations,
  AllocationSumError,
  DuplicateCostCentreError,
} from '@/modules/accounting/services/payroll/payrollCostAllocationService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_COMPANY = '11111111-1111-1111-1111-111111111111';
const EMP_ID = 'e0000001-0000-0000-0000-000000000001';
const CC_A = 'cc000001-0000-0000-0000-00000000000a';
const CC_B = 'cc000001-0000-0000-0000-00000000000b';
const CC_C = 'cc000001-0000-0000-0000-00000000000c';
const USER_ID = 'user-1';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('setEmployeeCostAllocations', () => {
  function mockHappyPath(): void {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM cost_centres')) return Promise.resolve([{ id: CC_A }, { id: CC_B }]);
      return Promise.resolve([]);
    };
  }

  it('rejects allocations that do not sum to 100', async () => {
    mockHappyPath();
    await expect(
      setEmployeeCostAllocations(COMPANY_ID, EMP_ID, [
        { costCentreId: CC_A, percentage: 60 },
        { costCentreId: CC_B, percentage: 30 },
      ], USER_ID),
    ).rejects.toBeInstanceOf(AllocationSumError);
  });

  it('rejects duplicate cost centres', async () => {
    mockHappyPath();
    await expect(
      setEmployeeCostAllocations(COMPANY_ID, EMP_ID, [
        { costCentreId: CC_A, percentage: 60 },
        { costCentreId: CC_A, percentage: 40 },
      ], USER_ID),
    ).rejects.toBeInstanceOf(DuplicateCostCentreError);
  });

  it('rejects zero or negative percentages', async () => {
    mockHappyPath();
    await expect(
      setEmployeeCostAllocations(COMPANY_ID, EMP_ID, [
        { costCentreId: CC_A, percentage: 100 },
        { costCentreId: CC_B, percentage: 0 },
      ], USER_ID),
    ).rejects.toThrow(/percentage/i);
  });

  it('replaces existing allocations in ONE unit of work (DELETE + INSERT)', async () => {
    mockHappyPath();
    await setEmployeeCostAllocations(COMPANY_ID, EMP_ID, [
      { costCentreId: CC_A, percentage: 60 },
      { costCentreId: CC_B, percentage: 40 },
    ], USER_ID);

    const seq = sqlCalls.map(c => c.sql);
    expect(seq.some(s => s.includes('DELETE FROM payroll_employee_cost_allocations'))).toBe(true);
    expect(seq.filter(s => s.includes('INSERT INTO payroll_employee_cost_allocations'))).toHaveLength(2);
    // No BEGIN/COMMIT assertion: the service no longer emits them. `sql` routes
    // onto the request's ALS client, so a raw COMMIT committed the WHOLE
    // request. withTransaction nests a SAVEPOINT instead, and the boundary is
    // not an observable statement in this log.
    expect(seq.some(s => s.trim() === 'BEGIN')).toBe(false);
    expect(seq.some(s => s.trim() === 'COMMIT')).toBe(false);
  });

  it('propagates a failing INSERT so the surrounding transaction unwinds', async () => {
    let insertCount = 0;
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM cost_centres')) return Promise.resolve([{ id: CC_A }, { id: CC_B }]);
      if (q.includes('INSERT INTO payroll_employee_cost_allocations')) {
        insertCount += 1;
        if (insertCount === 2) return Promise.reject(new Error('boom'));
      }
      return Promise.resolve([]);
    };

    await expect(
      setEmployeeCostAllocations(COMPANY_ID, EMP_ID, [
        { costCentreId: CC_A, percentage: 60 },
        { costCentreId: CC_B, percentage: 40 },
      ], USER_ID),
    ).rejects.toThrow(/boom/);

    // Rollback is withTransaction's savepoint, not a statement this service
    // emits. What the service owes its caller is that the error PROPAGATES —
    // swallowing it would leave the DELETE applied and the INSERTs missing.
    expect(sqlCalls.some(c => c.sql.trim() === 'ROLLBACK')).toBe(false);
    expect(sqlCalls.some(c => c.sql.trim() === 'COMMIT')).toBe(false);
  });

  it('clears allocations when given an empty array', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      return Promise.resolve([]);
    };
    await setEmployeeCostAllocations(COMPANY_ID, EMP_ID, [], USER_ID);
    expect(sqlCalls.some(c => c.sql.includes('DELETE FROM payroll_employee_cost_allocations'))).toBe(true);
    expect(sqlCalls.some(c => c.sql.includes('INSERT INTO payroll_employee_cost_allocations'))).toBe(false);
  });

  it('rejects employee not in the caller company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    await expect(
      setEmployeeCostAllocations(OTHER_COMPANY, EMP_ID, [{ costCentreId: CC_A, percentage: 100 }], USER_ID),
    ).rejects.toThrow(/not in company/i);
  });

  it('rejects cost centres not in the caller company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM cost_centres')) return Promise.resolve([{ id: CC_A }]);
      return Promise.resolve([]);
    };
    await expect(
      setEmployeeCostAllocations(COMPANY_ID, EMP_ID, [
        { costCentreId: CC_A, percentage: 60 },
        { costCentreId: CC_B, percentage: 40 },
      ], USER_ID),
    ).rejects.toThrow(/cost centre/i);
  });

  it('accepts tiny rounding error within 0.01 of 100', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('FROM cost_centres')) return Promise.resolve([{ id: CC_A }, { id: CC_B }, { id: CC_C }]);
      return Promise.resolve([]);
    };
    await expect(
      setEmployeeCostAllocations(COMPANY_ID, EMP_ID, [
        { costCentreId: CC_A, percentage: 33.33 },
        { costCentreId: CC_B, percentage: 33.33 },
        { costCentreId: CC_C, percentage: 33.34 },
      ], USER_ID),
    ).resolves.not.toThrow();
  });
});

describe('getEmployeeCostAllocations', () => {
  it('returns allocations ordered by percentage desc, then code', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employee_cost_allocations')) {
        return Promise.resolve([
          { id: 'a1', cost_centre_id: CC_A, cost_centre_code: 'ADMIN', cost_centre_name: 'Admin', percentage: '60.00' },
          { id: 'a2', cost_centre_id: CC_B, cost_centre_code: 'PROJ', cost_centre_name: 'Projects', percentage: '40.00' },
        ]);
      }
      return Promise.resolve([]);
    };
    const out = await getEmployeeCostAllocations(COMPANY_ID, EMP_ID);
    expect(out).toHaveLength(2);
    expect(out[0]!.percentage).toBe(60);
    expect(out[0]!.costCentreCode).toBe('ADMIN');
    expect(out[1]!.percentage).toBe(40);
    const call = sqlCalls.find(c => c.sql.includes('FROM payroll_employee_cost_allocations'));
    expect(call).toBeDefined();
    expect(call!.values).toContain(COMPANY_ID);
    expect(call!.values).toContain(EMP_ID);
  });

  it('returns [] when employee has no allocations', async () => {
    mockImpl = () => Promise.resolve([]);
    const out = await getEmployeeCostAllocations(COMPANY_ID, EMP_ID);
    expect(out).toEqual([]);
  });
});

describe('splitRunLineAcrossAllocations', () => {
  it('splits an amount pro-rata and puts residual on the last row so totals tie exactly', () => {
    const allocations = [
      { costCentreId: CC_A, percentage: 33.33 },
      { costCentreId: CC_B, percentage: 33.33 },
      { costCentreId: CC_C, percentage: 33.34 },
    ];
    const parts = splitRunLineAcrossAllocations(100, allocations);
    const sum = parts.reduce<number>((a, p) => a + p.amount, 0);
    expect(sum).toBeCloseTo(100, 10);
    expect(parts).toHaveLength(3);
    expect(parts[2]!.costCentreId).toBe(CC_C);
  });

  it('returns the whole amount on a single-row allocation', () => {
    const parts = splitRunLineAcrossAllocations(12345.67, [
      { costCentreId: CC_A, percentage: 100 },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.amount).toBeCloseTo(12345.67, 2);
  });

  it('handles 60/40 split cleanly', () => {
    const parts = splitRunLineAcrossAllocations(1000, [
      { costCentreId: CC_A, percentage: 60 },
      { costCentreId: CC_B, percentage: 40 },
    ]);
    expect(parts[0]!.amount).toBeCloseTo(600, 2);
    expect(parts[1]!.amount).toBeCloseTo(400, 2);
  });

  it('returns empty for empty allocations', () => {
    expect(splitRunLineAcrossAllocations(100, [])).toEqual([]);
  });
});
