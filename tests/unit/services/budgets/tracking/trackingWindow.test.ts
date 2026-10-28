/**
 * Budgets P3 §2.2: the tracking windows. Whole calendar months on both sides,
 * quarters counted from the FY start in 3-month blocks with a short last one
 * (a 14-month year has Q5 of 2 months), nothing assuming 12 months, the FY
 * always from the registry. The registry is faked by `YearSource`, so these
 * are the pure rules; the real registry read is exercised by the integration
 * suites.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveTrackingWindowFrom,
  type YearSource,
} from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { monthsSpanned } from '@/modules/accounting/services/gl/fiscalYearRegistry';

function fy(label: number, startDate: string, endDate: string): FiscalYearRecord {
  return {
    id: `fy-${label}`, fiscalYear: label, startDate, endDate, status: 'open', kind: 'normal',
    stored: true, months: monthsSpanned(startDate, endDate), assumed: false,
  };
}

function source(years: FiscalYearRecord[]): YearSource {
  return {
    async byLabel(label) { return years.find((y) => y.fiscalYear === label) ?? null; },
    async forDate(date) {
      const y = years.find((v) => v.startDate <= date && date <= v.endDate);
      if (!y) throw new Error(`no year for ${date}`);
      return y;
    },
  };
}

// 12-month years: FY2026 Mar 2025 - Feb 2026, FY2027 Mar 2026 - Feb 2027, FY2028 Mar 2027 - Feb 2028.
const TWELVE = source([
  fy(2026, '2025-03-01', '2026-02-28'), fy(2027, '2026-03-01', '2027-02-28'), fy(2028, '2027-03-01', '2028-02-29'),
]);
// A 14-month transition year: Mar 2026 - Apr 2027.
const FOURTEEN = source([fy(2027, '2026-03-01', '2027-04-30'), fy(2028, '2027-05-01', '2028-04-30')]);
// A 15-month transition year.
const FIFTEEN = source([fy(2027, '2026-03-01', '2027-05-31')]);
// A 7-month transition year: Mar - Sep 2026.
const SEVEN = source([fy(2027, '2026-03-01', '2026-09-30'), fy(2028, '2026-10-01', '2027-09-30')]);

const TODAY = '2026-10-26';

async function refusal(p: Promise<unknown>): Promise<TrackingError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a TrackingError').toBeInstanceOf(TrackingError);
  return err as TrackingError;
}

describe('month', () => {
  it('runs from the 1st to the month end and flags the in-progress month', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'month', month: '2026-10' }, TODAY);
    expect([w.startDate, w.endDate, w.months]).toEqual(['2026-10-01', '2026-10-31', ['2026-10']]);
    expect(w.inProgressMonth).toBe('2026-10');
    expect(w.fiscalYear).toBe(2027);
    expect(w.years).toEqual([{ fiscalYear: 2027, months: ['2026-10'] }]);
  });

  it('defaults to the month holding today', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'month' }, TODAY);
    expect([w.startDate, w.endDate]).toEqual(['2026-10-01', '2026-10-31']);
  });

  it('a past month is not in progress; February of a leap year ends on the 29th', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'month', month: '2028-02' }, TODAY);
    expect([w.startDate, w.endDate, w.inProgressMonth, w.fiscalYear]).toEqual(['2028-02-01', '2028-02-29', null, 2028]);
    const past = await resolveTrackingWindowFrom(TWELVE, { period: 'month', month: '2026-09' }, TODAY);
    expect(past.inProgressMonth).toBeNull();
  });

  it('refuses a day-level month', async () => {
    expect((await refusal(resolveTrackingWindowFrom(TWELVE, { period: 'month', month: '2026-10-05' }, TODAY))).status).toBe(400);
  });
});

describe('quarter: 3-month blocks from the FY start', () => {
  it('Q2 of a 12-month year is months 4-6', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'quarter', fiscalYear: 2027, quarter: 2 }, TODAY);
    expect([w.startDate, w.endDate, w.months.length, w.label]).toEqual(['2026-06-01', '2026-08-31', 3, 'Q2']);
    expect((await refusal(resolveTrackingWindowFrom(TWELVE, { period: 'quarter', fiscalYear: 2027, quarter: 5 }, TODAY))).status).toBe(400);
  });

  it('a 14-month year has Q1-Q4 of 3 months and Q5 of 2 months', async () => {
    const lengths: number[] = [];
    for (const quarter of [1, 2, 3, 4, 5]) {
      const w = await resolveTrackingWindowFrom(FOURTEEN, { period: 'quarter', fiscalYear: 2027, quarter }, TODAY);
      lengths.push(w.months.length);
      expect(w.fiscalYear).toBe(2027);
    }
    expect(lengths).toEqual([3, 3, 3, 3, 2]);
    const q4 = await resolveTrackingWindowFrom(FOURTEEN, { period: 'quarter', fiscalYear: 2027, quarter: 4 }, TODAY);
    expect([q4.startDate, q4.endDate]).toEqual(['2026-12-01', '2027-02-28']);
    const q5 = await resolveTrackingWindowFrom(FOURTEEN, { period: 'quarter', fiscalYear: 2027, quarter: 5 }, TODAY);
    expect([q5.startDate, q5.endDate, q5.months, q5.label]).toEqual(['2027-03-01', '2027-04-30', ['2027-03', '2027-04'], 'Q5 (2 months)']);
  });

  it('a 15-month year has a 3-month Q5; a 7-month year a 1-month Q3 and no Q4', async () => {
    const q5 = await resolveTrackingWindowFrom(FIFTEEN, { period: 'quarter', fiscalYear: 2027, quarter: 5 }, TODAY);
    expect([q5.months.length, q5.endDate, q5.label]).toEqual([3, '2027-05-31', 'Q5']);
    const q3 = await resolveTrackingWindowFrom(SEVEN, { period: 'quarter', fiscalYear: 2027, quarter: 3 }, TODAY);
    expect([q3.months, q3.label]).toEqual([['2026-09'], 'Q3 (1 month)']);
    expect((await refusal(resolveTrackingWindowFrom(SEVEN, { period: 'quarter', fiscalYear: 2027, quarter: 4 }, TODAY))).status).toBe(400);
  });

  it('defaults to the quarter holding today in the year holding today', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'quarter' }, TODAY);
    expect([w.startDate, w.endDate, w.label]).toEqual(['2026-09-01', '2026-11-30', 'Q3']);
  });

  it('an unknown year label is a 404', async () => {
    expect((await refusal(resolveTrackingWindowFrom(TWELVE, { period: 'quarter', fiscalYear: 2031, quarter: 1 }, TODAY))).status).toBe(404);
  });
});

describe('ytd and fy', () => {
  it('ytd runs to the end of the month holding today, flagged in progress', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'ytd' }, TODAY);
    expect([w.startDate, w.endDate, w.months.length, w.inProgressMonth]).toEqual(['2026-03-01', '2026-10-31', 8, '2026-10']);
  });

  it('ytd of a year that has ended is capped at its end', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'ytd', fiscalYear: 2026 }, TODAY);
    expect([w.startDate, w.endDate, w.months.length, w.inProgressMonth]).toEqual(['2025-03-01', '2026-02-28', 12, null]);
  });

  it('ytd closing in the last month of the year ends on the year end', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'ytd', fiscalYear: 2027 }, '2027-02-10');
    expect([w.endDate, w.months.length, w.inProgressMonth]).toEqual(['2027-02-28', 12, '2027-02']);
  });

  it('ytd of a year that has not started is empty, labelled with that year', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'ytd', fiscalYear: 2028 }, TODAY);
    expect([w.notStarted, w.months, w.startDate, w.endDate, w.fiscalYear, w.years]).toEqual([true, [], '2027-03-01', '2027-02-28', 2028, []]);
  });

  it('fy of a 14-month year has 14 months', async () => {
    const w = await resolveTrackingWindowFrom(FOURTEEN, { period: 'fy', fiscalYear: 2027 }, TODAY);
    expect([w.startDate, w.endDate, w.months.length, w.label]).toEqual(['2026-03-01', '2027-04-30', 14, 'FY2027']);
  });
});

describe('custom: month-granular', () => {
  it('a cross-FY window carries both years, FY* is the year holding its end', async () => {
    const w = await resolveTrackingWindowFrom(TWELVE, { period: 'custom', from: '2026-11', to: '2027-04' }, TODAY);
    expect([w.startDate, w.endDate, w.fiscalYear]).toEqual(['2026-11-01', '2027-04-30', 2028]);
    expect(w.years).toEqual([
      { fiscalYear: 2027, months: ['2026-11', '2026-12', '2027-01', '2027-02'] },
      { fiscalYear: 2028, months: ['2027-03', '2027-04'] },
    ]);
  });

  it('refuses a day-level date, from after to, and a range over 24 months', async () => {
    expect((await refusal(resolveTrackingWindowFrom(TWELVE, { period: 'custom', from: '2026-11-15', to: '2027-04' }, TODAY))).status).toBe(400);
    expect((await refusal(resolveTrackingWindowFrom(TWELVE, { period: 'custom', from: '2027-04', to: '2026-11' }, TODAY))).status).toBe(400);
    expect((await refusal(resolveTrackingWindowFrom(TWELVE, { period: 'custom', from: '2025-03', to: '2027-03' }, TODAY))).status).toBe(400);
    const max = await resolveTrackingWindowFrom(TWELVE, { period: 'custom', from: '2025-03', to: '2027-02' }, TODAY);
    expect(max.months.length).toBe(24);
  });

  it('refuses a missing bound', async () => {
    expect((await refusal(resolveTrackingWindowFrom(TWELVE, { period: 'custom', from: '2026-11' }, TODAY))).status).toBe(400);
  });
});

describe('calendar-month assumption', () => {
  it('a registry year that does not start on the 1st is refused, not shifted', async () => {
    const odd = source([fy(2027, '2026-03-15', '2027-03-14')]);
    expect((await refusal(resolveTrackingWindowFrom(odd, { period: 'fy', fiscalYear: 2027 }, TODAY))).status).toBe(409);
  });
});
