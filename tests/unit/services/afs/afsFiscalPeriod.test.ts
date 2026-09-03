/**
 * The AFS fiscal range is the single most consequential date calculation in
 * the product: it decides which twelve months a customer signs and files with
 * CIPC. It used to be hard-coded to January-December:
 *
 *     export function fiscalRange(year: number) {
 *       return { start: `${year}-01-01`, end: `${year}-12-31` };
 *     }
 *
 * with no reference to the company at all, so a February year-end reported a
 * whole quarter of the wrong trading.
 *
 * CONVENTION, stated once and tested here: fiscal year N is the year that
 * ENDS in calendar year N. That is what an accountant means by "the 2026
 * annual financial statements", it is what afs_documents.fiscal_year holds,
 * and for a January start it collapses to calendar year N — which is what
 * every production fiscal_periods row currently is.
 *
 * Note this is the opposite labelling to gl/fiscalYearBasis.fiscalYearStart,
 * which names a fiscal year by the year it STARTS in. Both are defensible;
 * having two unlabelled conventions is not, so each states its own.
 */
import { describe, it, expect } from 'vitest';
import { fiscalRangeFor } from '@/modules/accounting/services/afs/afsFiscalPeriod';

describe('fiscalRangeFor', () => {
  it('collapses to the calendar year for a January year start', () => {
    expect(fiscalRangeFor(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('spans two calendar years for the South African March year start', () => {
    // FY2026 for a 1 March company is 1 March 2025 to 28 February 2026.
    expect(fiscalRangeFor(2026, 3)).toEqual({ start: '2025-03-01', end: '2026-02-28' });
  });

  it('ends on 29 February in a leap year', () => {
    expect(fiscalRangeFor(2028, 3)).toEqual({ start: '2027-03-01', end: '2028-02-29' });
  });

  it('handles a year start in the middle of the calendar', () => {
    // 1 July 2025 to 30 June 2026.
    expect(fiscalRangeFor(2026, 7)).toEqual({ start: '2025-07-01', end: '2026-06-30' });
  });

  it('handles a December year start, where the year ends on 30 November', () => {
    expect(fiscalRangeFor(2026, 12)).toEqual({ start: '2025-12-01', end: '2026-11-30' });
  });

  it('produces ranges that are contiguous and non-overlapping year on year', () => {
    for (const month of [1, 3, 7, 12]) {
      const prior = fiscalRangeFor(2025, month);
      const current = fiscalRangeFor(2026, month);

      // The day after the prior year end is the current year start.
      const dayAfter = new Date(`${prior.end}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      expect(dayAfter.toISOString().slice(0, 10)).toBe(current.start);
    }
  });

  it('refuses a month outside 1-12 rather than clamping to March', () => {
    // A silent clamp is how a misconfigured tenant gets a year end a quarter
    // out with nothing on screen to say so.
    expect(() => fiscalRangeFor(2026, 0)).toThrow(/1-12/);
    expect(() => fiscalRangeFor(2026, 13)).toThrow(/1-12/);
    expect(() => fiscalRangeFor(2026, Number.NaN)).toThrow(/1-12/);
  });
});
