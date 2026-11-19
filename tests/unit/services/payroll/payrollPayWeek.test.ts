/**
 * Wave 6 FQd: the pay week. Which dates a weekly or fortnightly run pays for, its pay date, and its EMP201 month.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAY_WEEK, RunPeriodRefused, dayNumber, isoDow, judgePayWeekSettings, periodsAround, resolveRunPeriod,
} from '@/modules/accounting/services/payroll/payrollPayWeek';

const FORTNIGHT = { ...DEFAULT_PAY_WEEK, fortnightAnchor: '2026-03-02' };

describe('resolveRunPeriod', () => {
  it('a default week is Monday to Sunday, paid on its Friday, in the pay date\'s month', () => {
    expect(resolveRunPeriod('weekly', '2026-11-16', DEFAULT_PAY_WEEK)).toEqual({
      periodStart: '2026-11-16', periodEnd: '2026-11-22', payDate: '2026-11-20', periodYear: 2026, periodMonth: 11,
    });
  });

  it('a week across a month end belongs to the month it is paid in', () => {
    // Mon 23 Feb 2026 - Sun 1 Mar; paid Fri 27 Feb: February, tax year 2026.
    expect(resolveRunPeriod('weekly', '2026-02-23', DEFAULT_PAY_WEEK)).toMatchObject({ payDate: '2026-02-27', periodMonth: 2 });
    // Paid on the Sunday instead: 1 March, the next month and the next tax year.
    expect(resolveRunPeriod('weekly', '2026-02-23', { ...DEFAULT_PAY_WEEK, payWeekday: 7 }))
      .toMatchObject({ payDate: '2026-03-01', periodYear: 2026, periodMonth: 3 });
  });

  it('a pay day before the start day falls in the period\'s last 7 days', () => {
    // Week Wednesday-Tuesday, paid Monday: the Monday is the period's 6th day.
    expect(resolveRunPeriod('weekly', '2026-11-18', { payWeekStartDow: 3, payWeekday: 1, fortnightAnchor: null }))
      .toMatchObject({ periodStart: '2026-11-18', periodEnd: '2026-11-24', payDate: '2026-11-23' });
  });

  it('a fortnight is 14 days from the anchor, paid on the Friday of its second week', () => {
    // 2026-11-23 is 266 days (19 fortnights) after the anchor; paid Fri 4 Dec: the December EMP201.
    expect(resolveRunPeriod('fortnightly', '2026-11-23', FORTNIGHT)).toEqual({
      periodStart: '2026-11-23', periodEnd: '2026-12-06', payDate: '2026-12-04', periodYear: 2026, periodMonth: 12,
    });
    // Before the anchor too: a multiple of 14 days either way.
    expect(resolveRunPeriod('fortnightly', '2026-02-16', FORTNIGHT).periodEnd).toBe('2026-03-01');
  });

  it('refuses a start that is not the pay-week start day, naming both days', () => {
    expect(() => resolveRunPeriod('weekly', '2026-11-17', DEFAULT_PAY_WEEK))
      .toThrow('A weekly period starts on a Monday (the company\'s pay week); 2026-11-17 is a Tuesday.');
  });

  it('refuses a fortnight off the anchor\'s 14-day step, naming the two nearest starts', () => {
    expect(() => resolveRunPeriod('fortnightly', '2026-11-16', FORTNIGHT))
      .toThrow('A fortnight starts every 14 days from 2026-03-02: 2026-11-09 or 2026-11-23, not 2026-11-16.');
  });

  it('refuses a fortnight before the anchor is set', () => {
    expect(() => resolveRunPeriod('fortnightly', '2026-11-16', DEFAULT_PAY_WEEK))
      .toThrow('Set the fortnight start in the pay week settings before the first fortnightly run.');
  });

  it('refuses anything that is not a real date in range', () => {
    for (const bad of ['2026-02-30', '26-11-16', '2019-12-30', '2026-11-16T00:00', 20261116, null, undefined]) {
      expect(() => resolveRunPeriod('weekly', bad, DEFAULT_PAY_WEEK), String(bad)).toThrow(RunPeriodRefused);
    }
  });
});

describe('judgePayWeekSettings', () => {
  it('accepts day numbers 1-7 and an anchor on the start day; a blank anchor is none', () => {
    expect(judgePayWeekSettings({ payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: '' })).toEqual(DEFAULT_PAY_WEEK);
    expect(judgePayWeekSettings({ payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: '2026-03-02' })).toEqual(FORTNIGHT);
  });

  it('refuses a day outside 1-7, a non-integer, and an anchor off the start day', () => {
    for (const [s, d] of [[0, 5], [8, 5], [1, 0], [1.5, 5], ['1', 5]] as const) {
      expect(() => judgePayWeekSettings({ payWeekStartDow: s, payWeekday: d, fortnightAnchor: null }), `${s}/${d}`).toThrow(RunPeriodRefused);
    }
    expect(() => judgePayWeekSettings({ payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: '2026-03-03' }))
      .toThrow('The fortnight start must be a Monday, the day the pay week starts; 2026-03-03 is a Tuesday.');
    expect(() => judgePayWeekSettings({ payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: '2026-13-01' })).toThrow(RunPeriodRefused);
  });
});

describe('periodsAround', () => {
  it('lists every week from 13 weeks back to 4 ahead, newest first, each a valid start', () => {
    const weeks = periodsAround('weekly', DEFAULT_PAY_WEEK, '2026-11-18');
    expect(weeks[0]!.periodStart).toBe('2026-12-14');
    expect(weeks.at(-1)!.periodStart).toBe('2026-08-17');
    expect(weeks.map((w) => isoDow(dayNumber(w.periodStart)!))).toEqual(weeks.map(() => 1));
    expect(weeks).toHaveLength(18);
    for (const w of weeks) expect(resolveRunPeriod('weekly', w.periodStart, DEFAULT_PAY_WEEK)).toEqual(w);
  });

  it('lists fortnights on the anchor\'s step, and none without an anchor', () => {
    const f = periodsAround('fortnightly', FORTNIGHT, '2026-11-18');
    expect(f.map((p) => p.periodStart)).toContain('2026-11-23');
    for (const p of f) expect(resolveRunPeriod('fortnightly', p.periodStart, FORTNIGHT)).toEqual(p);
    expect(periodsAround('fortnightly', DEFAULT_PAY_WEEK, '2026-11-18')).toEqual([]);
  });
});

describe('labels', () => {
  it('a range names its year once, or both across a year end; a pay date names its day', async () => {
    const { formatPeriodRange, formatPayDate } = await import('@/modules/accounting/services/payroll/payrollPayWeek');
    expect(formatPeriodRange('2026-11-16', '2026-11-22')).toBe('16 Nov - 22 Nov 2026');
    expect(formatPeriodRange('2026-12-28', '2027-01-03')).toBe('28 Dec 2026 - 3 Jan 2027');
    expect(formatPayDate('2026-11-20')).toBe('Fri 20 Nov 2026');
  });
});
