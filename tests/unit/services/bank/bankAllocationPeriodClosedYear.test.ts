/**
 * WP2 row 12 round 2: a fiscal year the registry reports closed or locked, with no period to resolve, is refused as a
 * CLOSED YEAR, not with the "create the period first" advice that only fits a date outside the auto-create window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ensureMock, yearMock } = vi.hoisted(() => ({ ensureMock: vi.fn(), yearMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: async (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodAutoCreate', async (orig) => ({
  ...(await orig<object>()), ensureFiscalPeriodForDate: ensureMock,
}));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: yearMock }));

import { allocationPeriodFor } from '@/modules/accounting/services/bank/bankAllocationPeriod';

const thisYear = new Date().getFullYear();
const DATE = `${thisYear - 1}-06-10`;

describe('allocationPeriodFor: no period resolved', () => {
  beforeEach(() => { vi.clearAllMocks(); ensureMock.mockResolvedValue(null); });

  it.each(['closed', 'locked'])('names a %s fiscal year as such', async (status) => {
    yearMock.mockResolvedValue({ fiscalYear: thisYear - 1, startDate: `${thisYear - 1}-01-01`, endDate: `${thisYear - 1}-12-31`, status });
    const err = await allocationPeriodFor('c-1', DATE).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(new RegExp(`fiscal year FY${thisYear - 1} .* is ${status}`));
    expect(err.message).not.toMatch(/Create the period first/);
  });

  it('keeps the window advice for an open year with no period', async () => {
    yearMock.mockResolvedValue({ fiscalYear: thisYear - 1, startDate: `${thisYear - 1}-01-01`, endDate: `${thisYear - 1}-12-31`, status: 'open' });
    const err = await allocationPeriodFor('c-1', DATE).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/Create the period first/);
  });
});
