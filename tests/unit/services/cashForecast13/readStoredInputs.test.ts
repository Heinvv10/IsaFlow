/**
 * An unreadable store (a SQLSTATE error from listItems, listOverrides or getPayDay) is a `source_unavailable`
 * warning and the forecast still returns, without that input; any other error is a bug and propagates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listItems = vi.fn();
const listOverrides = vi.fn();
const getPayDay = vi.fn();
const payrollItemsSpy = vi.fn((..._a: unknown[]) => [] as unknown[]);
vi.mock('@/lib/neon', () => ({ withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(), sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/cashForecast13/itemsRepo', () => ({ listItems: (...a: unknown[]) => listItems(...a) }));
vi.mock('@/modules/accounting/services/cashForecast13/overridesRepo', () => ({ listOverrides: (...a: unknown[]) => listOverrides(...a) }));
vi.mock('@/modules/accounting/services/cashForecast13/payDaySetting', () => ({ getPayDay: (...a: unknown[]) => getPayDay(...a) }));
// The other sources of the forecast, empty (as service.test.ts does).
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({ getCashBalance: async () => ({ total: 0 }) }));
vi.mock('@/modules/accounting/services/cashForecast13/readReceivables', () => ({
  readReceivables: async () => ({ items: [], gross: [], summary: { totalCents: 0, beyondHorizonCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 }, leftover: new Map() }),
  readPayables: async () => ({ items: [], gross: [] }),
}));
vi.mock('@/modules/accounting/services/cashForecast13/readPayroll', () => ({
  readPayroll: async () => ({ latest: null, runs: [], unsupportedFrequency: false }), payrollItems: (...a: unknown[]) => payrollItemsSpy(...a),
}));
vi.mock('@/modules/accounting/services/cashForecast13/readBudget', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/cashForecast13/readBudget')>()), readBudget: async () => null,
}));
vi.mock('@/modules/accounting/services/cashForecast13/readSars', () => ({ sarsItems: async () => [] }));
vi.mock('@/modules/accounting/services/cashForecast13/readLoans', () => ({ loanItems: async () => [] }));
vi.mock('@/modules/accounting/services/cashForecast13/readRecurring', () => ({ recurringReceiptItems: async () => [] }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: vi.fn() }));

import { readStoredInputs } from '@/modules/accounting/services/cashForecast13/readStoredInputs';
import { getCashForecast13 } from '@/modules/accounting/services/cashForecast13/cashForecast13Service';
import type { ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';

const TODAY = '2026-11-18';
const sqlError = () => Object.assign(new Error('permission denied for table'), { code: '42501' });
const ITEM = { id: 'i1', direction: 'receipt', amount: 10, date: '2026-11-25', repeat: 'none', repeatUntil: null, description: 'Deposit', category: 'other' };
const OVR = { id: 'o1', lineKey: 'manual:i1', weekStart: '2026-11-23', mode: 'set', amount: 20, note: null, createdAt: '', updatedAt: '' };

beforeEach(() => {
  listItems.mockReset(); listItems.mockResolvedValue([ITEM]);
  listOverrides.mockReset(); listOverrides.mockResolvedValue([OVR]);
  getPayDay.mockReset(); getPayDay.mockResolvedValue({ payDay: { kind: 'last_working_day' }, day: 25, isDefault: false });
  payrollItemsSpy.mockClear();
});

describe('readStoredInputs', () => {
  it('reads and adapts all three when they are readable, with no warning', async () => {
    const w: ForecastWarning[] = [];
    const s = await readStoredInputs('co', TODAY, w);
    expect(w).toEqual([]);
    expect(s).toEqual({
      payDay: 'last_working_day',
      manualItems: [{ id: 'i1', date: '2026-11-25', amountCents: 1000, description: 'Deposit', category: 'other', repeat: null }],
      overrides: [{ lineKey: 'manual:i1', weekIndex: 1, mode: 'set', amountCents: 2000 }],
    });
  });

  it.each([
    ['items', listItems, 'expected cash items', (s: Awaited<ReturnType<typeof readStoredInputs>>) => expect(s.manualItems).toEqual([])],
    ['overrides', listOverrides, 'forecast overrides', (s: Awaited<ReturnType<typeof readStoredInputs>>) => expect(s.overrides).toEqual([])],
    ['pay day', getPayDay, 'salary pay day', (s: Awaited<ReturnType<typeof readStoredInputs>>) => expect(s.payDay).toBeNull()],
  ])('an unreadable %s store is one source_unavailable warning; the other inputs still come', async (_n, fn, source, empty) => {
    fn.mockRejectedValue(sqlError());
    const w: ForecastWarning[] = [];
    const s = await readStoredInputs('co', TODAY, w);
    expect(w).toEqual([expect.objectContaining({ code: 'source_unavailable', source })]);
    empty(s);
    const others = [s.manualItems.length > 0, s.overrides.length > 0, s.payDay !== null].filter(Boolean);
    expect(others).toHaveLength(2);
  });

  it.each([['items', listItems], ['overrides', listOverrides], ['pay day', getPayDay]])('a non-SQL error in the %s store propagates', async (_n, fn) => {
    fn.mockRejectedValue(new TypeError('bug'));
    await expect(readStoredInputs('co', TODAY, [])).rejects.toThrow('bug');
  });
});

describe('getCashForecast13 with an unreadable store', () => {
  it('still returns the forecast, warns, and falls back (no items / no overrides / day 25)', async () => {
    listItems.mockRejectedValue(sqlError());
    listOverrides.mockRejectedValue(sqlError());
    getPayDay.mockRejectedValue(sqlError());
    const f = await getCashForecast13('co', TODAY);
    expect(f.weeks).toHaveLength(13);
    expect(f.warnings.filter((w) => w.code === 'source_unavailable').map((w) => w.source))
      .toEqual(['expected cash items', 'forecast overrides', 'salary pay day']);
    expect(f.lines.some((l) => l.key.startsWith('manual:') || l.kind === 'override')).toBe(false);
    expect(payrollItemsSpy.mock.calls[0]?.[1]).toBe(25);
  });

  it('a non-SQL error in a store is not swallowed by the forecast', async () => {
    getPayDay.mockRejectedValue(new TypeError('bug'));
    await expect(getCashForecast13('co', TODAY)).rejects.toThrow('bug');
  });
});
