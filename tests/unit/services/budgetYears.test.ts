/** listBudgetYears refuses a stored year that spans no months with a BudgetInputError, not a TypeError. */
import { describe, expect, it, vi } from 'vitest';

const year = (over: Record<string, unknown>) => ({
  id: 'y', fiscalYear: 2026, startDate: '2026-03-01', endDate: '2027-02-28', status: 'open', kind: 'normal',
  stored: true, months: 12, assumed: false, ...over,
});
const registry = vi.hoisted(() => ({ listFiscalYears: vi.fn(), fiscalYearForDate: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => registry);

import { listBudgetYears } from '@/modules/accounting/services/core/budgetYears';
import { BudgetInputError } from '@/modules/accounting/services/core/budgetMonths';

describe('listBudgetYears', () => {
  it('a year whose end precedes its start is a BudgetInputError naming the label', async () => {
    const broken = year({ fiscalYear: 2027, startDate: '2027-03-01', endDate: '2027-02-01' });
    registry.listFiscalYears.mockResolvedValue([broken]);
    registry.fiscalYearForDate.mockResolvedValue(broken);
    const err = await listBudgetYears('c', '2027-03-01').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetInputError);
    expect((err as Error).message).toMatch(/2027/);
  });

  it('a normal year lists itself and the year after it', async () => {
    const ok = year({});
    registry.listFiscalYears.mockResolvedValue([ok]);
    registry.fiscalYearForDate.mockImplementation(async (_c: string, d: string) =>
      d < '2027-03-01' ? ok : year({ fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29' }));
    const years = await listBudgetYears('c', '2026-06-01');
    expect(years.map(y => y.fiscalYear)).toEqual([2026, 2028]);
  });
});
