import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

const OPENING_ROWS = [{ balance: 15000 }];

const ALLOCATION_ROWS = [
  { cash_group: 'cash_received_from_customers', amount:  80000 },
  { cash_group: 'cash_paid_to_suppliers',       amount: -45000 },
  { cash_group: 'cash_paid_to_employees',       amount: -20000 },
  { cash_group: 'other_operating',              amount:  -3000 },
  { cash_group: 'investing',                    amount: -10000 },
  { cash_group: 'financing',                    amount:   5000 },
];

describe('cashFlowDirectService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns correct section totals', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(ALLOCATION_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.periodStart).toBe(PERIOD_START);
    expect(result.periodEnd).toBe(PERIOD_END);
    expect(result.openingCash).toBeCloseTo(15000, 2);
    expect(result.operatingTotal).toBeCloseTo(12000, 2);
    expect(result.investingTotal).toBeCloseTo(-10000, 2);
    expect(result.financingTotal).toBeCloseTo(5000, 2);
    expect(result.closingCash).toBeCloseTo(22000, 2);
  });

  it('exposes line items for each operating group', async () => {
    mockSql
      .mockResolvedValueOnce(OPENING_ROWS)
      .mockResolvedValueOnce(ALLOCATION_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    const customers = result.operatingItems.find(i => i.cashGroup === 'cash_received_from_customers');
    expect(customers?.amount).toBeCloseTo(80000, 2);

    const employees = result.operatingItems.find(i => i.cashGroup === 'cash_paid_to_employees');
    expect(employees?.amount).toBeCloseTo(-20000, 2);
  });

  it('returns zero cash when no bank transactions exist', async () => {
    mockSql
      .mockResolvedValueOnce([{ balance: 0 }])
      .mockResolvedValueOnce([]);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.openingCash).toBe(0);
    expect(result.operatingTotal).toBe(0);
    expect(result.closingCash).toBe(0);
  });

  it('logs error and re-throws on DB failure', async () => {
    mockSql.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('timeout');
  });
});
