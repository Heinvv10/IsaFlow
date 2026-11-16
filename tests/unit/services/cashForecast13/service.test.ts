import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatCents } from '@/lib/money/formatMoney';

const balance = vi.fn();
const budget = vi.fn();
const receivables = vi.fn();
const recurring = vi.fn();
vi.mock('@/lib/neon', () => ({ withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(), sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({ getCashBalance: (...a: unknown[]) => balance(...a) }));
vi.mock('@/modules/accounting/services/cashForecast13/readReceivables', () => ({
  readReceivables: (...a: unknown[]) => receivables(...a),
  readPayables: async () => ({ items: [], gross: [] }),
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
vi.mock('@/modules/accounting/services/cashForecast13/readRecurring', () => ({ recurringReceiptItems: (...a: unknown[]) => recurring(...a) }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: vi.fn() }));

import type { KnownItem } from '@/modules/accounting/services/cashForecast13/types';
import { CashForecastUnavailableError, getCashForecast13 } from '@/modules/accounting/services/cashForecast13/cashForecast13Service';

const SUMMARY = { totalCents: 0, beyondHorizonCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 };
const item = (ref: string, date: string, amountCents: number, lineKey = 'ar:c1:due'): KnownItem => ({
  lineKey, lineLabel: 'C1', category: 'customer_receipts', entityId: 'c1', date, amountCents, ref, refLabel: ref,
});

beforeEach(() => {
  balance.mockReset(); budget.mockReset(); budget.mockResolvedValue(null);
  receivables.mockReset(); receivables.mockResolvedValue({ items: [], gross: [], summary: SUMMARY, leftover: new Map() });
  recurring.mockReset(); recurring.mockResolvedValue([]);
});

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

  it('the budget fill subtracts the gross AR, so a netted receipt is not refilled (re-review N1)', async () => {
    balance.mockResolvedValue({ total: 0 });
    receivables.mockResolvedValue({ items: [item('i1', '2026-11-20', 460_000_00)], gross: [item('i1', '2026-11-20', 500_000_00)], summary: SUMMARY, leftover: new Map() });
    budget.mockResolvedValue({ months: [{ month: '2026-11', customerReceipts: 1_000_000_00, supplierPayments: 0 }], vatSettlements: [], taxEvents: [], refundLagMonths: 1 });
    const f = await getCashForecast13('co', '2026-11-16');
    expect(f.lines.find((l) => l.key === 'ar:c1:due')?.totalCents).toBe(460_000_00);
    expect(f.lines.find((l) => l.key === 'budget:customer_receipts')).toBeUndefined();
  });

  it('credit left after the open invoices nets the customer’s recurring receipts earliest first; only the rest is credit_unused (re-review L-c)', async () => {
    balance.mockResolvedValue({ total: 0 });
    receivables.mockResolvedValue({ items: [], gross: [], summary: SUMMARY, leftover: new Map([['c1', 1_500], ['c9', 70]]) });
    recurring.mockResolvedValue([item('t:1', '2026-12-20', 1_000, 'recurring:t'), item('t:0', '2026-11-25', 1_000, 'recurring:t')]);
    budget.mockResolvedValue(null);
    const f = await getCashForecast13('co', '2026-11-18');
    expect(f.lines.find((l) => l.key === 'recurring:t')!.items.map((i) => [i.ref, i.amountCents])).toEqual([['t:1', 500]]);
    expect(f.warnings.find((w) => w.code === 'credit_unused')?.message).toContain(formatCents(70));
  });

  it('the budget fill subtracts the GROSS recurring receipt, not what credit left of it (round-3 LOW 2)', async () => {
    balance.mockResolvedValue({ total: 0 });
    // today 2026-12-01: all 31 December days are in the horizon. Budget R31, recurring R10 netted to 0 by R10 credit.
    receivables.mockResolvedValue({ items: [], gross: [], summary: SUMMARY, leftover: new Map([['c1', 1_000]]) });
    recurring.mockResolvedValue([item('t:0', '2026-12-10', 1_000, 'recurring:t')]);
    budget.mockResolvedValue({ months: [{ month: '2026-12', customerReceipts: 3_100, supplierPayments: 0 }], vatSettlements: [], taxEvents: [], refundLagMonths: 1 });
    const f = await getCashForecast13('co', '2026-12-01');
    expect(f.lines.find((l) => l.key === 'recurring:t')).toBeUndefined();
    expect(f.lines.find((l) => l.key === 'budget:customer_receipts')?.totalCents).toBe(2_100);
  });
});
