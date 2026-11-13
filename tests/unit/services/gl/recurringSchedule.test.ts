/**
 * K-048 LOW 3 — `advanceDate` overflowed a month-end template.
 *
 * `new Date('2026-01-31')` then `setMonth(+1)` produces 3 March, so a monthly
 * template on the 31st skipped February and drifted to the 3rd forever. The run
 * is claimed on `next_run_date` and the journal is DATED at it, so the drift
 * reached the general ledger rather than only the schedule.
 */
import { describe, expect, it } from 'vitest';
import { advanceDate, frequencyPeriodLabel, frequencyPeriodUnit } from '@/modules/accounting/services/gl/recurringSchedule';

describe('advanceDate — monthly', () => {
  it('clamps 31 January to the last day of February, in a non-leap year', () => {
    // 2027 is not a leap year. The old arithmetic gave 2027-03-03.
    expect(advanceDate('2027-01-31', 'monthly')).toBe('2027-02-28');
  });

  it('clamps 31 January to 29 February in a leap year', () => {
    expect(advanceDate('2028-01-31', 'monthly')).toBe('2028-02-29');
  });

  it('carries month end forward out of a non-leap February', () => {
    // 28 February is that month's last day, so the anchor is month end and the
    // next run is 31 March — not 28 March, which would lose the 31st for good.
    expect(advanceDate('2027-02-28', 'monthly')).toBe('2027-03-31');
  });

  it('carries month end forward out of a leap February', () => {
    expect(advanceDate('2028-02-29', 'monthly')).toBe('2028-03-31');
  });

  it('does not treat 28 February in a LEAP year as month end', () => {
    // 2028-02-28 is not the last day of that month, so it stays on the 28th.
    expect(advanceDate('2028-02-28', 'monthly')).toBe('2028-03-28');
  });

  it('clamps 30 January — not itself a month end — to 28 February', () => {
    // The clamp is doing the work here, not the month-end rule: 30 January is
    // not the last day of January, so without it the result is "2027-02-30",
    // which is not a day and which a DATE column rejects outright.
    expect(advanceDate('2027-01-30', 'monthly')).toBe('2027-02-28');
  });

  it('clamps 29 January to 28 February in a non-leap year, and keeps it in a leap one', () => {
    expect(advanceDate('2027-01-29', 'monthly')).toBe('2027-02-28');
    expect(advanceDate('2028-01-29', 'monthly')).toBe('2028-02-29');
  });

  it('clamps 30 January to 29 February in a leap year', () => {
    expect(advanceDate('2028-01-30', 'monthly')).toBe('2028-02-29');
  });

  it('clamps a non-month-end quarterly day the target month does not have', () => {
    expect(advanceDate('2026-11-29', 'quarterly')).toBe('2027-02-28');
  });

  it('clamps 31 August to 30 September', () => {
    expect(advanceDate('2026-08-31', 'monthly')).toBe('2026-09-30');
  });

  it('carries 30 September on to 31 October', () => {
    expect(advanceDate('2026-09-30', 'monthly')).toBe('2026-10-31');
  });

  it('leaves an ordinary mid-month date on its own day', () => {
    expect(advanceDate('2026-09-15', 'monthly')).toBe('2026-10-15');
  });

  it('rolls December over into the next year', () => {
    expect(advanceDate('2026-12-31', 'monthly')).toBe('2027-01-31');
  });

  it('does not drift a month-end template over a full year of runs', () => {
    let d = '2026-12-31';
    const seen: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      d = advanceDate(d, 'monthly');
      seen.push(d);
    }
    expect(seen).toEqual([
      '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30',
      '2027-05-31', '2027-06-30', '2027-07-31', '2027-08-31',
      '2027-09-30', '2027-10-31', '2027-11-30', '2027-12-31',
    ]);
  });
});

describe('advanceDate — other frequencies', () => {
  it('adds seven days for weekly, across a month boundary', () => {
    expect(advanceDate('2026-08-29', 'weekly')).toBe('2026-09-05');
  });

  it('adds seven days for weekly, across a year boundary', () => {
    expect(advanceDate('2026-12-29', 'weekly')).toBe('2027-01-05');
  });

  it('clamps a quarterly month end', () => {
    expect(advanceDate('2026-11-30', 'quarterly')).toBe('2027-02-28');
  });

  it('carries 31 May on to 31 August for quarterly', () => {
    expect(advanceDate('2026-05-31', 'quarterly')).toBe('2026-08-31');
  });

  it('clamps 29 February to 28 February a year later', () => {
    expect(advanceDate('2028-02-29', 'annually')).toBe('2029-02-28');
  });

  it('keeps an ordinary date on its own day for annually', () => {
    expect(advanceDate('2026-06-15', 'annually')).toBe('2027-06-15');
  });
});

describe('advanceDate — a frequency it has not been taught', () => {
  // The silent `return dateStr` this replaces was the K-048 double-post
  // restored: the caller claims the run with the returned date, so an
  // unchanged one leaves `next_run_date = <due>` matching for ever and every
  // Generate posts another journal on the same day. Unreachable while the
  // CHECK on recurring_journals.frequency holds — which is why it must fail
  // loudly the day it does not.
  it('throws rather than returning the input date unchanged', () => {
    expect(() => advanceDate('2026-03-31', 'daily')).toThrow(/unsupported recurring frequency 'daily'/);
  });

  it('throws on an empty frequency', () => {
    expect(() => advanceDate('2026-03-31', '')).toThrow(/unsupported recurring frequency/);
  });

  it('does not treat a Object.prototype key as a frequency', () => {
    // An object-literal lookup resolves these on Object.prototype, so the
    // guard saw a function rather than undefined and the arithmetic returned
    // the string 'NaN-NaN-NaN' as a run date. This test found that.
    expect(() => advanceDate('2026-03-31', 'constructor')).toThrow(/unsupported recurring frequency/);
    expect(() => advanceDate('2026-03-31', 'toString')).toThrow(/unsupported recurring frequency/);
  });
});

describe('advanceDate — month ends around #1106', () => {
  it.each([
    ['monthly', '2026-10-31', '2026-11-30'],
    ['monthly', '2026-11-30', '2026-12-31'],
    ['monthly', '2027-01-29', '2027-02-28'],
    ['monthly', '2027-01-30', '2027-02-28'],
    ['monthly', '2027-01-31', '2027-02-28'],
    ['monthly', '2028-01-29', '2028-02-29'],
    ['monthly', '2028-01-31', '2028-02-29'],
    ['quarterly', '2026-08-31', '2026-11-30'],
    ['quarterly', '2026-11-30', '2027-02-28'],
    ['quarterly', '2027-11-30', '2028-02-29'],
  ])('%s from %s is %s', (frequency, from, to) => {
    expect(advanceDate(from, frequency)).toBe(to);
  });
});

describe('frequencyPeriodLabel — the period a run belongs to, as the edit refusal names it', () => {
  it('names the month, quarter, year, and the ISO week by its Monday', () => {
    expect(frequencyPeriodLabel('2026-10-20', 'monthly')).toBe('October 2026');
    expect(frequencyPeriodLabel('2026-11-03', 'quarterly')).toBe('Q4 2026');
    expect(frequencyPeriodLabel('2026-03-31', 'quarterly')).toBe('Q1 2026');
    expect(frequencyPeriodLabel('2026-06-30', 'annually')).toBe('2026');
    expect(frequencyPeriodLabel('2026-11-15', 'weekly')).toBe('The week of 2026-11-09'); // a Sunday: its Monday before
    expect(frequencyPeriodLabel('2026-11-09', 'weekly')).toBe('The week of 2026-11-09');
    expect(frequencyPeriodLabel('2027-01-01', 'weekly')).toBe('The week of 2026-12-28'); // across the year
  });
  it('maps each frequency to its period unit', () => {
    expect(['weekly', 'monthly', 'quarterly', 'annually'].map(frequencyPeriodUnit)).toEqual(['week', 'month', 'quarter', 'year']);
  });
});
