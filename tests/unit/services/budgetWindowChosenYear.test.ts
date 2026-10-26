/** resolveBudgetWindow for a CHOSEN financial year: full year is its whole range, year to date is held inside it. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/fiscalYearRegistry')>()),
  fiscalYearForDate: vi.fn(),
}));

import { resolveBudgetWindow } from '@/modules/accounting/services/reports/budgetWindowService';
import type { FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';

const YEAR = {
  id: 'y', fiscalYear: 2026, startDate: '2026-01-01', endDate: '2027-02-28', status: 'open', kind: 'transition',
  stored: true, months: 14, assumed: false,
} as FiscalYearRecord;
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe('resolveBudgetWindow with a chosen year', () => {
  it('full_year is the chosen year\'s whole range whatever today is', async () => {
    for (const now of [at(2025, 6, 1), at(2026, 10, 23), at(2030, 1, 1)]) {
      expect(await resolveBudgetWindow('c', 'full_year', now, YEAR))
        .toEqual({ startDate: '2026-01-01', endDate: '2027-02-28', fiscalYear: YEAR, notStarted: false });
    }
  });

  it('year to date runs from the year\'s start to the end of today\'s month inside the year', async () => {
    // Budgets are whole months, so the actuals run to the same month end (decision 17).
    expect((await resolveBudgetWindow('c', 'ytd', at(2026, 10, 23), YEAR)).endDate).toBe('2026-10-31');
    expect((await resolveBudgetWindow('c', 'ytd', at(2027, 2, 3), YEAR)).endDate).toBe('2027-02-28');
  });

  it('year to date of a finished year ends with the year', async () => {
    expect((await resolveBudgetWindow('c', 'ytd', at(2028, 5, 5), YEAR)).endDate).toBe('2027-02-28');
  });

  it('year to date of a year not yet begun is EMPTY (ends before it starts) and says so', async () => {
    const w = await resolveBudgetWindow('c', 'ytd', at(2025, 6, 1), YEAR);
    expect(w).toEqual({ startDate: '2026-01-01', endDate: '2025-12-31', fiscalYear: YEAR, notStarted: true });
  });

  it('the full year of a year not yet begun is its whole range, not flagged', async () => {
    const w = await resolveBudgetWindow('c', 'full_year', at(2025, 6, 1), YEAR);
    expect([w.startDate, w.endDate, w.notStarted]).toEqual(['2026-01-01', '2027-02-28', false]);
  });

  it('a started year is never flagged', async () => {
    expect((await resolveBudgetWindow('c', 'ytd', at(2026, 1, 1), YEAR)).notStarted).toBe(false);
    expect((await resolveBudgetWindow('c', 'ytd', at(2028, 5, 5), YEAR)).notStarted).toBe(false);
  });
});
