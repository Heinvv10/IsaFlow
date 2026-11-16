import { describe, it, expect, vi, beforeEach } from 'vitest';

const balance = vi.fn();
const budget = vi.fn();
vi.mock('@/lib/neon', () => ({ withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(), sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({ getCashBalance: (...a: unknown[]) => balance(...a) }));
vi.mock('@/modules/accounting/services/cashForecast13/readReceivables', () => ({
  readReceivables: async () => ({ items: [], summary: { totalCents: 0, beyondHorizonCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 } }),
  readPayables: async () => [],
}));
vi.mock('@/modules/accounting/services/cashForecast13/readPayroll', () => ({
  readPayroll: async () => ({ latest: null, runs: [], unsupportedFrequency: true }), payrollItems: () => [],
}));
vi.mock('@/modules/accounting/services/cashForecast13/readBudget', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/cashForecast13/readBudget')>()),
  readBudget: (...a: unknown[]) => budget(...a),
}));
vi.mock('@/modules/accounting/services/cashForecast13/readSars', () => ({ sarsItems: async () => [] }));
vi.mock('@/modules/accounting/services/cashForecast13/readLoans', () => ({ loanItems: async () => [] }));
vi.mock('@/modules/accounting/services/cashForecast13/readRecurring', () => ({ recurringReceiptItems: async () => [] }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: vi.fn() }));

import { CashForecastUnavailableError, getCashForecast13 } from '@/modules/accounting/services/cashForecast13/cashForecast13Service';

beforeEach(() => { balance.mockReset(); budget.mockReset(); budget.mockResolvedValue(null); });

describe('cash13 service', () => {
  it('refuses (typed) when opening cash cannot be read, instead of forecasting from zero (review L5)', async () => {
    balance.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    await expect(getCashForecast13('co', '2026-11-18')).rejects.toBeInstanceOf(CashForecastUnavailableError);
  });

  it('opens at the balance; a domain refusal in the budget source is its warning; a weekly payroll is warned', async () => {
    balance.mockResolvedValue({ total: 1234.56 });
    budget.mockRejectedValue(new Error('fiscalYearForDate: no fiscal year for company co on 2027-02-14'));
    const f = await getCashForecast13('co', '2026-11-18');
    expect(f.weeks[0]!.openingCents).toBe(123_456);
    expect(f.warnings.map((w) => w.code)).toEqual(['payroll_no_runs', 'payroll_frequency_unsupported', 'source_unavailable']);
  });

  it('a code bug in a source is not swallowed', async () => {
    balance.mockResolvedValue({ total: 0 });
    budget.mockRejectedValue(new TypeError('bug'));
    await expect(getCashForecast13('co', '2026-11-18')).rejects.toThrow('bug');
  });
});
