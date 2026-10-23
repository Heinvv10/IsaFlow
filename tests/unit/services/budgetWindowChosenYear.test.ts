/** resolveBudgetWindow for a CHOSEN financial year: full year is its whole range, year to date is held inside it. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: vi.fn() }));

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
        .toEqual({ startDate: '2026-01-01', endDate: '2027-02-28', fiscalYear: YEAR });
    }
  });

  it('year to date runs from the year\'s start to today inside the year', async () => {
    expect((await resolveBudgetWindow('c', 'ytd', at(2026, 10, 23), YEAR)).endDate).toBe('2026-10-23');
  });

  it('year to date of a finished year ends with the year', async () => {
    expect((await resolveBudgetWindow('c', 'ytd', at(2028, 5, 5), YEAR)).endDate).toBe('2027-02-28');
  });

  it('year to date of a year not yet begun is held at its first day, never before its start', async () => {
    const w = await resolveBudgetWindow('c', 'ytd', at(2025, 6, 1), YEAR);
    expect([w.startDate, w.endDate]).toEqual(['2026-01-01', '2026-01-01']);
  });
});
