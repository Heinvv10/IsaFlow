/**
 * hours / line_total must describe the SAME entry.
 *
 * `time_entries.hours` is NUMERIC(6,2), so Postgres rounds what it is given.
 * line_total used to be derived in JS from the pre-rounding value, so the two
 * could disagree: `hours: 0.004` stored as 0.00 while carrying a line_total of
 * 0.004 * rate — a zero-hour entry with a real billable amount.
 */
import { describe, it, expect } from 'vitest';
import { roundHours, lineTotalFor } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';

describe('roundHours', () => {
  it('rounds to the column scale', () => {
    expect(roundHours(1.999)).toBe(2);
    expect(roundHours(0.004)).toBe(0);
    expect(roundHours(0.005)).toBe(0.01);
    expect(roundHours(7.5)).toBe(7.5);
  });
});

describe('lineTotalFor', () => {
  it('derives from the STORED hours, so the two never disagree', () => {
    // 1.999h stores as 2.00h. Billing 1999 against a stored 2.00 would be a
    // R1 discrepancy the timesheet cannot explain.
    expect(lineTotalFor(1.999, 1000)).toBe(2000);
  });

  it('gives a zero total for hours that round to zero', () => {
    expect(lineTotalFor(0.004, 1000)).toBe(0);
  });

  it('stays null when no rate is configured', () => {
    expect(lineTotalFor(2, null)).toBeNull();
  });

  it('agrees with stored hours x rate across a spread of values', () => {
    for (const h of [0.01, 0.25, 1.005, 2.675, 7.5, 23.999]) {
      const stored = roundHours(h);
      expect(lineTotalFor(h, 850)).toBeCloseTo(Math.round(stored * 850 * 100) / 100, 2);
    }
  });
});
