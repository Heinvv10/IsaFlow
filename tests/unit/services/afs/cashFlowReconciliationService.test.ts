import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: vi.fn(),
}));
// The bank balance and indirect closing are cash.balance.v1 (K-091g).
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({
  getCashBalance: vi.fn(),
}));

import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

const mockGetDirect = getCashFlowDirect as MockedFunction<typeof getCashFlowDirect>;
const mockGetCash = getCashBalance as MockedFunction<typeof getCashBalance>;
const cash = (total: number) => ({ asAt: '2026-12-31', total, accounts: [], deactivatedWithBalance: [], postedThrough: null });

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

const DIRECT_REPORT = {
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  openingCash: 15000,
  operatingItems: [],
  operatingTotal: 12000,
  investingItems: [],
  investingTotal: -10000,
  financingItems: [],
  financingTotal: 5000,
  netChange: 7000,
  closingCash: 22000,
};

describe('cashFlowReconciliationService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks isReconciled true when all three figures agree', async () => {
    mockGetDirect.mockResolvedValueOnce(DIRECT_REPORT);
    mockGetCash.mockResolvedValue(cash(22000));

    const result = await getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.directClosing).toBeCloseTo(22000, 2);
    expect(result.indirectClosing).toBeCloseTo(22000, 2);
    expect(result.bankBalance).toBeCloseTo(22000, 2);
    expect(result.variance).toBeCloseTo(0, 2);
    expect(result.isReconciled).toBe(true);
  });

  it('marks isReconciled false and reports variance when figures differ', async () => {
    const offDirect = { ...DIRECT_REPORT, closingCash: 21950 };
    mockGetDirect.mockResolvedValueOnce(offDirect);
    mockGetCash.mockResolvedValue(cash(22000));

    const result = await getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.isReconciled).toBe(false);
    expect(Math.abs(result.variance)).toBeCloseTo(50, 2);
  });

  it('logs error and re-throws on DB failure', async () => {
    mockGetDirect.mockRejectedValueOnce(new Error('query failed'));

    await expect(
      getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('query failed');
  });
});
