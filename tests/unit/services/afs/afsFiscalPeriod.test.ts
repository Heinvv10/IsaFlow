/**
 * The AFS fiscal range is the single most consequential date calculation in
 * the product: it decides which months a customer signs and files with CIPC. It
 * used to be hard-coded to January-December, then derived from the company's
 * CURRENT start month. It is now read from the fiscal-year registry (a stored
 * year keeps its own dates), so these tests drive the real registry reader
 * through a fake of the two database functions (tests/helpers/fiscalYearSqlFake).
 *
 * CONVENTION, stated once and tested here: fiscal year N is the year that
 * ENDS in calendar year N. That is what an accountant means by "the 2026
 * annual financial statements" and what afs_documents.fiscal_year holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fiscalYearSqlFake, MARCH_YEARS, TRANSITION_YEARS, type FakeYear,
} from '../../../helpers/fiscalYearSqlFake';

const state = vi.hoisted(() => ({ sql: (async () => []) as (...a: unknown[]) => Promise<unknown[]> }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => state.sql(...a) }));

import {
  getFiscalRange, getFiscalRangeWithPrior, getPriorFiscalRange, fiscalWindowForPeriod,
} from '@/modules/accounting/services/afs/afsFiscalPeriod';

function useYears(years: readonly FakeYear[]) {
  const fake = fiscalYearSqlFake(years);
  state.sql = fake as unknown as typeof state.sql;
  return fake;
}

beforeEach(() => { useYears(MARCH_YEARS); });

describe('getFiscalRange', () => {
  it('is the stored year with that label: a March year spans two calendar years', async () => {
    // FY2026 for a 1 March company is 1 March 2025 to 28 February 2026.
    expect(await getFiscalRange('c1', 2026)).toEqual({ start: '2025-03-01', end: '2026-02-28' });
  });

  it('returns a transition year at its real length, not twelve months', async () => {
    useYears(TRANSITION_YEARS);
    expect(await getFiscalRange('c1', 2027)).toEqual({ start: '2026-01-01', end: '2027-02-28' });
  });

  it('keeps a past year on the dates it had after a change of year end', async () => {
    useYears(TRANSITION_YEARS);
    // Today's declared start is March, yet FY2026 stays the calendar year it was.
    expect(await getFiscalRange('c1', 2026)).toEqual({ start: '2025-01-01', end: '2025-12-31' });
  });

  it('refuses a label no year carries rather than guessing a range', async () => {
    await expect(getFiscalRange('c1', 2099)).rejects.toThrow(/no financial year labelled 2099/);
  });
});

describe('getFiscalRangeWithPrior', () => {
  it('returns the year and the year immediately before it', async () => {
    const { current, prior } = await getFiscalRangeWithPrior('c1', 2026, true);
    expect(current).toEqual({ start: '2025-03-01', end: '2026-02-28' });
    expect(prior).toEqual({ start: '2024-03-01', end: '2025-02-28' });
  });

  it('takes the REAL prior year of a transition year, not fy-1 on the current start month', async () => {
    useYears(TRANSITION_YEARS);
    const { current, prior } = await getFiscalRangeWithPrior('c1', 2027, true);
    expect(current).toEqual({ start: '2026-01-01', end: '2027-02-28' });
    // The year holding the day before 2026-01-01: the calendar year 2025.
    expect(prior).toEqual({ start: '2025-01-01', end: '2025-12-31' });
  });

  it('returns a null comparative when none is asked for', async () => {
    const { current, prior } = await getFiscalRangeWithPrior('c1', 2026);
    expect(current).toEqual({ start: '2025-03-01', end: '2026-02-28' });
    expect(prior).toBeNull();
  });
});

describe('getPriorFiscalRange', () => {
  it('is the year before, whatever label it carries', async () => {
    useYears(TRANSITION_YEARS);
    expect(await getPriorFiscalRange('c1', 2028)).toEqual({ start: '2026-01-01', end: '2027-02-28' });
  });
});

describe('fiscalWindowForPeriod', () => {
  it('is the calendar year for a January year', async () => {
    useYears([{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31' },
      { fiscalYear: 2025, startDate: '2025-01-01', endDate: '2025-12-31' }]);
    expect(await fiscalWindowForPeriod('c1', '202612')).toEqual({
      start: '202601', end: '202612', priorEnd: '202512',
    });
  });

  it('opens in the prior calendar year for a February year end', async () => {
    expect(await fiscalWindowForPeriod('c1', '202602')).toEqual({
      start: '202503', end: '202602', priorEnd: '202502',
    });
  });

  it('keeps an interim period in the year that is still open', async () => {
    expect(await fiscalWindowForPeriod('c1', '202509')).toEqual({
      start: '202503', end: '202509', priorEnd: '202502',
    });
  });

  it('puts the opening month itself at the start of its own year', async () => {
    expect(await fiscalWindowForPeriod('c1', '202503')).toEqual({
      start: '202503', end: '202503', priorEnd: '202502',
    });
    // One month earlier still belongs to the year before.
    expect(await fiscalWindowForPeriod('c1', '202502')).toEqual({
      start: '202403', end: '202502', priorEnd: '202402',
    });
  });

  it('opens a transition year at its own start, 14 months back from its end', async () => {
    useYears(TRANSITION_YEARS);
    expect(await fiscalWindowForPeriod('c1', '202702')).toEqual({
      start: '202601', end: '202702', priorEnd: '202512',
    });
  });

  it('refuses a period that is not YYYYMM with a month 01-12 before asking the registry', async () => {
    const fake = useYears(MARCH_YEARS);
    await expect(fiscalWindowForPeriod('c1', '202600')).rejects.toThrow(/YYYYMM/);
    await expect(fiscalWindowForPeriod('c1', '202613')).rejects.toThrow(/YYYYMM/);
    await expect(fiscalWindowForPeriod('c1', '2026')).rejects.toThrow(/YYYYMM/);
    expect(fake.calls).toEqual([]);
  });
});
