import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: vi.fn(),
}));
// The indirect closing is the REAL indirect statement (cashFlowIndirectService), not the cash balance again.
vi.mock('@/modules/accounting/services/reports/cashFlowIndirectService', () => ({
  getIndirectCashFlow: vi.fn(),
}));
// The bank balance is cash.balance.v1 (K-091g).
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({
  getCashBalance: vi.fn(),
}));

import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getIndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';
import { getCashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

const mockGetDirect = getCashFlowDirect as MockedFunction<typeof getCashFlowDirect>;
const mockGetCash = getCashBalance as MockedFunction<typeof getCashBalance>;
const mockGetIndirect = getIndirectCashFlow as MockedFunction<typeof getIndirectCashFlow>;
// The statement always closes on the ledger's cash; `unexplainedDifference` is what its journals could not account for.
const statement = (closingCash: number, unexplainedDifference = 0) => ({ periodStart: PERIOD_START, periodEnd: PERIOD_END, openingCash: 15000, sections: [], netChange: closingCash - 15000, closingCash, unexplainedDifference });
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
  beforeEach(() => { vi.clearAllMocks(); mockGetIndirect.mockResolvedValue(statement(22000)); });

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

  it('reads the indirect closing from the indirect statement for the same company and period', async () => {
    mockGetDirect.mockResolvedValueOnce(DIRECT_REPORT);
    mockGetCash.mockResolvedValue(cash(22000));
    await getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END);
    expect(mockGetIndirect).toHaveBeenCalledWith(COMPANY_ID, PERIOD_START, PERIOD_END);
  });

  it('flags an indirect statement that does not tie to the ledger cash, even when direct and bank agree', async () => {
    // The #1149 case: the journals' movements reach 287 750 while the ledger holds 287 900 (a movement left out). The
    // statement closes on the ledger and says so with an unexplained difference of 150.
    mockGetDirect.mockResolvedValueOnce({ ...DIRECT_REPORT, closingCash: 287900 });
    mockGetCash.mockResolvedValue(cash(287900));
    mockGetIndirect.mockResolvedValue(statement(287900, 150));

    const result = await getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.indirectClosing).toBe(287750);
    expect(result.directClosing).toBe(287900);
    expect(result.bankBalance).toBe(287900);
    expect(result.isReconciled).toBe(false);
    expect(result.variance).toBeCloseTo(150, 2);
  });

  it('logs error and re-throws on DB failure', async () => {
    mockGetDirect.mockRejectedValueOnce(new Error('query failed'));

    await expect(
      getCashFlowReconciliation(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('query failed');
  });
});
