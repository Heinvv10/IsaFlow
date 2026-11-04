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
  cashPayRegisterForRun,
  splitIntoDenominations,
} from '@/modules/accounting/services/payroll/cashPayRegisterService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN_ID = 'r0000001-0000-0000-0000-000000000001';
const EMP_ID = 'e0000001-0000-0000-0000-000000000001';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('splitIntoDenominations', () => {
  it('produces a greedy breakdown summing to the input amount', () => {
    const parts = splitIntoDenominations(1234.85);
    const sum = parts.reduce<number>((s, p) => s + p.denomination * p.count, 0);
    expect(sum).toBeCloseTo(1234.85, 2);
  });

  it('handles a round R200 amount with one denomination row', () => {
    const parts = splitIntoDenominations(400);
    const nonZero = parts.filter(p => p.count > 0);
    expect(nonZero).toEqual([{ denomination: 200, count: 2 }]);
  });

  it('handles cents amounts', () => {
    const parts = splitIntoDenominations(0.85);
    const nonZero = parts.filter(p => p.count > 0);
    const totalCents = nonZero.reduce<number>((s, p) => s + Math.round(p.denomination * 100) * p.count, 0);
    expect(totalCents).toBe(85);
  });

  it('returns all zero rows for 0', () => {
    const parts = splitIntoDenominations(0);
    expect(parts.every(p => p.count === 0)).toBe(true);
  });

  it('rejects negative amount', () => {
    expect(() => splitIntoDenominations(-1)).toThrow(/negative/i);
  });
});

describe('cashPayRegisterForRun', () => {
  it('returns per-employee rows + rollup for cash employees only', async () => {
    mockImpl = () => Promise.resolve([
      {
        run_id: RUN_ID, employee_id: EMP_ID, employee_number: 'E001',
        first_name: 'Jane', last_name: 'Doe', payment_method: 'cash',
        net_pay: '1234.85', validation_results: [],
      },
    ]);
    const reg = await cashPayRegisterForRun(COMPANY_ID, RUN_ID);
    expect(reg.rows).toHaveLength(1);
    expect(reg.rows[0]!.employeeNumber).toBe('E001');
    expect(reg.totals.totalNet).toBeCloseTo(1234.85, 2);
    expect(reg.totals.denominations.find(d => d.denomination === 1000)?.count ?? 0).toBe(0);
  });

  it('returns empty rows when no cash employees', async () => {
    mockImpl = () => Promise.resolve([{ run_id: RUN_ID, employee_id: null }]);
    const reg = await cashPayRegisterForRun(COMPANY_ID, RUN_ID);
    expect(reg.rows).toHaveLength(0);
    expect(reg.totals.totalNet).toBe(0);
  });

  it('rejects run belonging to another company', async () => {
    mockImpl = () => Promise.resolve([]);
    await expect(cashPayRegisterForRun(COMPANY_ID, RUN_ID)).rejects.toThrow(/not found/i);
  });

  it('query filters by payment_method=cash', async () => {
    mockImpl = () => Promise.resolve([{ run_id: RUN_ID, employee_id: null }]);
    await cashPayRegisterForRun(COMPANY_ID, RUN_ID);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.sql).toContain('validation_results');
    expect(sqlCalls[0]!.sql).toContain('payment_method');
  });

  it('checks every line for a blocker from the same query snapshot as the register', async () => {
    mockImpl = () => Promise.resolve([
      {
        run_id: RUN_ID, employee_id: EMP_ID, employee_number: 'E001',
        first_name: 'Jane', last_name: 'Doe', payment_method: 'eft', net_pay: '0',
        validation_results: [{
          code: 'LOAN_INSTALMENT_EXCEEDS_PAY', severity: 'error', rawNet: -100, loans: ['L-1'],
        }],
      },
    ]);

    await expect(cashPayRegisterForRun(COMPANY_ID, RUN_ID))
      .rejects.toThrow(/Jane Doe.*E001.*L-1/i);
    expect(sqlCalls).toHaveLength(1);
  });
});
