/**
 * The fiscal-year calendar: the ONE place that turns a company's
 * `financial_year_start` month into period boundaries.
 *
 * Written first. `createFiscalYear` hard-coded January–December for every
 * company, while every production company carries `financial_year_start = 3`.
 * The result is 72 Brightsphere periods, none of which line up with the year
 * the AFS is signed for, and a year-end close that rolls the wrong twelve
 * months into retained earnings.
 *
 * The labelling convention is NOT invented here — `afs/pisCalculatorService`
 * already reads `financial_year_start` this way (start month in the PRIOR
 * calendar year, end month = start − 1 in the labelled year), which is the SA
 * convention of naming a year by the February it ends in. Matching it is the
 * point: a second convention would be a second derivation.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFiscalYearPeriods,
  fiscalYearOfDate,
  fiscalYearRange,
  isCalendarAligned,
  FISCAL_YEAR_DEFAULT_START_MONTH,
} from '@/modules/accounting/services/gl/fiscalYearCalendar';

describe('fiscalYearRange', () => {
  it('runs a March-start year from 1 March of the prior year to the end of February', () => {
    expect(fiscalYearRange(2027, 3)).toEqual({
      startDate: '2026-03-01',
      endDate: '2027-02-28',
    });
  });

  it('lands the last day of February on the 29th in a leap year', () => {
    // 2028 is a leap year: FY2028 ends 29 February 2028, not the 28th.
    expect(fiscalYearRange(2028, 3).endDate).toBe('2028-02-29');
  });

  it('keeps a January-start year on the calendar year it is named for', () => {
    expect(fiscalYearRange(2026, 1)).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
  });

  it('handles a December start — the year begins in December of the prior year', () => {
    expect(fiscalYearRange(2026, 12)).toEqual({
      startDate: '2025-12-01',
      endDate: '2026-11-30',
    });
  });

  it('refuses a month outside 1–12 rather than producing a silently wrong range', () => {
    expect(() => fiscalYearRange(2026, 0)).toThrow(/financial year start month/i);
    expect(() => fiscalYearRange(2026, 13)).toThrow(/financial year start month/i);
  });
});

describe('buildFiscalYearPeriods', () => {
  it('builds twelve consecutive months starting at the fiscal year start', () => {
    const periods = buildFiscalYearPeriods(2027, 3);
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({
      periodNumber: 1,
      periodName: 'March 2026',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });
    expect(periods[11]).toEqual({
      periodNumber: 12,
      periodName: 'February 2027',
      startDate: '2027-02-01',
      endDate: '2027-02-28',
    });
  });

  it('numbers periods by fiscal position, not by calendar month', () => {
    // Period 11 of a March-start year is January — not period 1.
    const jan = buildFiscalYearPeriods(2027, 3).find((p) => p.periodName.startsWith('January'));
    expect(jan?.periodNumber).toBe(11);
  });

  it('leaves no gap and no overlap between consecutive periods', () => {
    const periods = buildFiscalYearPeriods(2027, 3);
    for (let i = 1; i < periods.length; i++) {
      const prevEnd = new Date(`${periods[i - 1]!.endDate}T00:00:00Z`);
      const thisStart = new Date(`${periods[i]!.startDate}T00:00:00Z`);
      expect(thisStart.getTime() - prevEnd.getTime()).toBe(86_400_000);
    }
  });

  it('spans exactly the fiscal year range it was asked for', () => {
    const range = fiscalYearRange(2027, 3);
    const periods = buildFiscalYearPeriods(2027, 3);
    expect(periods[0]!.startDate).toBe(range.startDate);
    expect(periods[11]!.endDate).toBe(range.endDate);
  });

  it('reproduces the calendar layout when the year starts in January', () => {
    const periods = buildFiscalYearPeriods(2026, 1);
    expect(periods[0]!.startDate).toBe('2026-01-01');
    expect(periods[0]!.periodName).toBe('January 2026');
    expect(periods[11]!.endDate).toBe('2026-12-31');
  });
});

describe('fiscalYearOfDate', () => {
  it('puts a February date in the year that ends in that February', () => {
    expect(fiscalYearOfDate('2027-02-15', 3)).toBe(2027);
  });

  it('puts a March date in the NEXT labelled year — this is the boundary that breaks', () => {
    // 1 March 2026 opens FY2027. Reading the calendar year off the string, as
    // ensureFiscalPeriodForDate used to, gives 2026 and resolves no period.
    expect(fiscalYearOfDate('2026-03-01', 3)).toBe(2027);
    expect(fiscalYearOfDate('2026-02-28', 3)).toBe(2026);
  });

  it('is the calendar year when the fiscal year starts in January', () => {
    expect(fiscalYearOfDate('2026-01-01', 1)).toBe(2026);
    expect(fiscalYearOfDate('2026-12-31', 1)).toBe(2026);
  });

  it('agrees with fiscalYearRange for every month of a March-start year', () => {
    for (let m = 1; m <= 12; m++) {
      const iso = `2026-${String(m).padStart(2, '0')}-15`;
      const fy = fiscalYearOfDate(iso, 3);
      const range = fiscalYearRange(fy, 3);
      expect(iso >= range.startDate && iso <= range.endDate).toBe(true);
    }
  });

  it('accepts a Date as well as a YYYY-MM-DD string — pg returns Date for DATE columns', () => {
    expect(fiscalYearOfDate(new Date(2026, 2, 1), 3)).toBe(2027);
  });

  it('refuses an unparseable date rather than guessing a year', () => {
    expect(() => fiscalYearOfDate('not-a-date', 3)).toThrow(/date/i);
  });
});

describe('isCalendarAligned', () => {
  it('is true only for a January start', () => {
    expect(isCalendarAligned(1)).toBe(true);
    expect(isCalendarAligned(3)).toBe(false);
  });
});

describe('FISCAL_YEAR_DEFAULT_START_MONTH', () => {
  it('defaults to March, matching every production company and the SA tax year', () => {
    expect(FISCAL_YEAR_DEFAULT_START_MONTH).toBe(3);
  });
});
