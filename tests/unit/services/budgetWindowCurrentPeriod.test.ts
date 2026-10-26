/**
 * resolveBudgetWindow without a chosen year (budgets P0, D8 + D12):
 * `current` is the whole fiscal period holding today, `ytd` runs to the end of
 * today's month, and an unknown period is refused.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/fiscalYearRegistry')>()),
  fiscalYearForDate: vi.fn(),
  periodForDate: vi.fn(),
}));

import { assertBudgetPeriod, BudgetPeriodError, resolveBudgetWindow } from '@/modules/accounting/services/reports/budgetWindowService';
import { fiscalYearForDate, periodForDate, type FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow } from '@/modules/accounting/services/reports/budgetPeriodWindow';

const YEAR = {
  id: 'y', fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', status: 'open', kind: 'normal',
  stored: true, months: 12, assumed: false,
} as FiscalYearRecord;
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 10);

beforeEach(() => {
  vi.mocked(fiscalYearForDate).mockReset().mockResolvedValue(YEAR);
  vi.mocked(periodForDate).mockReset().mockResolvedValue(null);
});

describe('resolveBudgetWindow: current', () => {
  it('current is the fiscal period holding today, widened to whole calendar months', async () => {
    vi.mocked(periodForDate).mockResolvedValue({
      id: 'p', fiscalYearId: 'y', fiscalYear: 2027, periodNumber: 8,
      startDate: '2026-09-27', endDate: '2026-10-31', status: 'open',
    } as Awaited<ReturnType<typeof periodForDate>>);
    // A period that is not the calendar month (27 Sep - 31 Oct): budgets are whole
    // months, so the window covers all of September and October on BOTH sides,
    // never two months of budget against five weeks of actuals.
    const w = await resolveBudgetWindow('c', 'current', at(2026, 10, 26));
    expect(w).toMatchObject({ startDate: '2026-09-01', endDate: '2026-10-31', notStarted: false });
    expect(budgetMonthKeysInWindow(w.startDate, w.endDate)).toEqual(['2026-09', '2026-10']);
    expect(vi.mocked(periodForDate)).toHaveBeenCalledWith('c', '2026-10-26');
  });

  it('a calendar-month period row is used as it is', async () => {
    vi.mocked(periodForDate).mockResolvedValue({
      id: 'p', fiscalYearId: 'y', fiscalYear: 2027, periodNumber: 8,
      startDate: '2026-10-01', endDate: '2026-10-31', status: 'open',
    } as Awaited<ReturnType<typeof periodForDate>>);
    const w = await resolveBudgetWindow('c', 'current', at(2026, 10, 26));
    expect(w).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31' });
  });

  it('a mid-month period (15 Oct - 14 Nov) covers October and November whole', async () => {
    vi.mocked(periodForDate).mockResolvedValue({
      id: 'p', fiscalYearId: 'y', fiscalYear: 2027, periodNumber: 8,
      startDate: '2026-10-15', endDate: '2026-11-14', status: 'open',
    } as Awaited<ReturnType<typeof periodForDate>>);
    const w = await resolveBudgetWindow('c', 'current', at(2026, 10, 26));
    expect(w).toMatchObject({ startDate: '2026-10-01', endDate: '2026-11-30' });
    expect(vi.mocked(periodForDate)).toHaveBeenCalledWith('c', '2026-10-26');
  });

  it('no period row: the whole calendar month', async () => {
    const w = await resolveBudgetWindow('c', 'current', at(2026, 10, 26));
    expect(w).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31' });
  });
});

describe('resolveBudgetWindow: ytd', () => {
  it('ytd ends at the end of the month holding today, capped at FY end', async () => {
    expect(await resolveBudgetWindow('c', 'ytd', at(2026, 10, 26)))
      .toMatchObject({ startDate: '2026-03-01', endDate: '2026-10-31' });
    // A year that ends mid-month: the month end is capped at the year end.
    vi.mocked(fiscalYearForDate).mockResolvedValue({ ...YEAR, endDate: '2027-02-14' });
    expect((await resolveBudgetWindow('c', 'ytd', at(2027, 2, 3))).endDate).toBe('2027-02-14');
  });

  it('full_year is unchanged', async () => {
    expect(await resolveBudgetWindow('c', 'full_year', at(2026, 10, 26)))
      .toMatchObject({ startDate: '2026-03-01', endDate: '2027-02-28' });
  });
});

describe('assertBudgetPeriod', () => {
  it('unknown period is a BudgetPeriodError', () => {
    for (const bad of ['quarter', 'YTD', 'full year', ['ytd'], 7]) {
      expect(() => assertBudgetPeriod(bad)).toThrow(BudgetPeriodError);
    }
    expect(() => assertBudgetPeriod('quarter')).toThrow('period must be current, ytd or full_year');
  });

  it('accepts the three periods and defaults an absent one to ytd', () => {
    expect(assertBudgetPeriod('current')).toBe('current');
    expect(assertBudgetPeriod('ytd')).toBe('ytd');
    expect(assertBudgetPeriod('full_year')).toBe('full_year');
    expect(assertBudgetPeriod(undefined)).toBe('ytd');
    expect(assertBudgetPeriod('')).toBe('ytd');
  });

  it('resolveBudgetWindow refuses an unknown period too', async () => {
    await expect(resolveBudgetWindow('c', 'quarter', at(2026, 10, 26))).rejects.toThrow(BudgetPeriodError);
  });
});
