import { describe, it, expect, afterAll } from 'vitest';
import {
  formatDisplayDate, formatDisplayDateTime, formatDisplayDateLong, formatDisplayDateShort,
  formatDisplayMonthYear, formatDisplayMonthYearLong, formatDisplayTime, formatDisplayTimeSeconds,
  formatDisplayDateWeekday, formatDisplayDateWeekdayShort, formatDateISO, formatDateTimeISO, getTodayISO,
} from '@/utils/dateFormat';

// The device is far from SAST (Los Angeles, UTC-7/-8) so a formatter that reads a zoned timestamp in
// device time or in UTC is caught. Set at import, before any Date below is built.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('formatDisplayDate: strict ISO in, anything else back unchanged', () => {
  it('shows a plain ISO date as dd MMM yyyy, with no timezone shift', () => {
    expect(formatDisplayDate('2026-10-21')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-01-05')).toBe('05 Jan 2026');
    expect(formatDisplayDate('2026-12-31')).toBe('31 Dec 2026');
    expect(formatDisplayDate('2024-02-29')).toBe('29 Feb 2024');
  });

  it('shows text that is not an ISO date exactly as it came (a count, a code, a hash is never a date)', () => {
    for (const text of ['INV-001', 'Period 3', '123', '1234', 'a3f9c2d41b', '2026', '2026-10', 'next week', '12 Oct', '1/2/2026']) {
      expect(formatDisplayDate(text)).toBe(text);
    }
    expect(formatDisplayDate('2026-02-30')).toBe('2026-02-30');
    expect(formatDisplayDate('2100-02-29')).toBe('2100-02-29');
    expect(formatDisplayDate('2026-02-30T10:00:00Z')).toBe('2026-02-30T10:00:00Z');
  });

  it('reads a zoned timestamp as the SAST day, whatever the device zone: 22:00Z is already tomorrow', () => {
    expect(formatDisplayDate('2026-10-20T22:00:00Z')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-10-20T21:59:59Z')).toBe('20 Oct 2026');
    expect(formatDisplayDate('2026-10-21T22:30:00.000Z')).toBe('22 Oct 2026');
    expect(formatDisplayDate('2026-10-21T23:30:00+02:00')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-10-21T00:10:00+02:00')).toBe('21 Oct 2026');
  });

  it('keeps the day a zone-less timestamp names', () => {
    expect(formatDisplayDate('2026-10-21T00:00:00')).toBe('21 Oct 2026');
    expect(formatDisplayDate('2026-10-21 23:59:59')).toBe('21 Oct 2026');
  });

  it('reads a Date from its own local calendar fields: new Date(y, m-1, d) is that day on any device', () => {
    expect(formatDisplayDate(new Date(2026, 9, 21, 0, 0, 0))).toBe('21 Oct 2026');
    expect(formatDisplayDate(new Date(2026, 9, 21, 23, 59, 59))).toBe('21 Oct 2026');
    expect(formatDisplayDate(new Date(2026, 0, 1))).toBe('01 Jan 2026');
  });

  it('shows the one "no date" mark for nothing, and the fallback you pass', () => {
    expect(formatDisplayDate(null)).toBe('—');
    expect(formatDisplayDate(undefined)).toBe('—');
    expect(formatDisplayDate('')).toBe('—');
    expect(formatDisplayDate('   ')).toBe('—');
    expect(formatDisplayDate(new Date(NaN))).toBe('—');
    expect(formatDisplayDate(null, 'n/a')).toBe('n/a');
  });
});

describe('periods are not days', () => {
  it('shows "YYYY-MM" as a month in the month forms, and passes it through as a date', () => {
    expect(formatDisplayMonthYear('2026-10')).toBe('Oct 2026');
    expect(formatDisplayMonthYearLong('2026-10')).toBe('October 2026');
    expect(formatDisplayDate('2026-10')).toBe('2026-10');
    expect(formatDisplayDateShort('2026-10')).toBe('2026-10');
    expect(formatDisplayMonthYear('2026-13')).toBe('2026-13');
    expect(formatDisplayMonthYear('2026')).toBe('2026');
  });
});

describe('the other display forms are fixed strings, not ICU', () => {
  const at = '2026-10-04T23:30:00Z'; // 05 Oct 2026 01:30 in Johannesburg
  it('formats each form from a zoned timestamp (SAST)', () => {
    expect(formatDisplayDateTime(at)).toBe('05 Oct 2026, 01:30');
    expect(formatDisplayDateLong(at)).toBe('5 October 2026');
    expect(formatDisplayDateShort(at)).toBe('5 Oct');
    expect(formatDisplayMonthYear(at)).toBe('Oct 2026');
    expect(formatDisplayTime(at)).toBe('01:30');
    expect(formatDisplayTimeSeconds('2026-10-20T22:00:05Z')).toBe('00:00:05');
  });
  it('formats a local Date from its own fields', () => {
    expect(formatDisplayDateTime(new Date(2026, 9, 5, 1, 30, 7))).toBe('05 Oct 2026, 01:30');
    expect(formatDisplayTimeSeconds(new Date(2026, 9, 5, 1, 30, 7))).toBe('01:30:07');
  });
  it('shows the one "no date" mark, and non-dates unchanged', () => {
    for (const f of [formatDisplayDateTime, formatDisplayDateLong, formatDisplayDateShort, formatDisplayMonthYear, formatDisplayTime]) {
      expect(f(null)).toBe('—');
      expect(f('INV-001')).toBe('INV-001');
    }
  });
  it('computes weekdays from the calendar date', () => {
    expect(formatDisplayDateWeekdayShort('2026-10-21')).toBe('Wed, 21 Oct 2026');
    expect(formatDisplayDateWeekdayShort('2024-02-29')).toBe('Thu, 29 Feb 2024');
    expect(formatDisplayDateWeekday('2026-10-15')).toBe('Thursday, 15 October 2026');
    expect(formatDisplayDateWeekday('2026-02-25')).toBe('Wednesday, 25 February 2026');
    expect(formatDisplayDateWeekday('2026-02-29')).toBe('2026-02-29');
  });
});

describe('ISO forms (files and APIs) keep master semantics', () => {
  it('passes a plain ISO date through and reads a Date in local fields', () => {
    expect(formatDateISO('2026-10-21')).toBe('2026-10-21');
    expect(formatDateISO(new Date(2026, 9, 21, 0, 0))).toBe('2026-10-21');
    expect(formatDateTimeISO(new Date(2026, 9, 21, 7, 5))).toBe('2026-10-21 07:05');
    expect(formatDateISO(null)).toBe('');
    expect(formatDateISO('garbage')).toBe('');
    expect(getTodayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
